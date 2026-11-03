import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {rcpFixture,registeredRcpPolicy} from './helpers/rcp-fixture.mjs';
import {createRepositoryPolicyCommit,withRepositoryPolicyRefAdmission,observePolicyCommit} from '../src/repository-commit-policy/runtime.mjs';
import {run} from '../src/util.mjs';
import {withoutGitProcessOverrides} from '../src/git-enterprise-environment.mjs';
import {operationForCommit,readCommitPolicyRecord} from '../src/repository-commit-policy/records.mjs';
const environment=()=>({...withoutGitProcessOverrides(process.env),GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'});
function request(f,tree,id='one'){return {subject:f.subject,purpose:'story',ref:f.ref,tree,parents:[f.parent],message:'implement behavior\n\nSingularity-Flow-Transaction: test',allowedPaths:['source.js'],operationId:id};}
async function advance(f,result){return withRepositoryPolicyRefAdmission(result.admission,()=>run('git',['update-ref','--no-deref',f.ref,result.commit,f.parent],{cwd:f.root,env:environment()}));}

test('registered object verification precedes the owner CAS and preserves unrelated staging',async t=>{
 const f=await rcpFixture(t); const tree=await f.candidate();
 await writeFile(path.join(f.root,'unrelated.txt'),'user work\n');f.git(f.root,['add','unrelated.txt']);
 const before=f.git(f.root,['diff','--cached']);
 const result=await createRepositoryPolicyCommit(f.root,request(f,tree));
 assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 const object=observePolicyCommit(f.root,result.commit); assert.equal(object.tree,tree);assert.equal(object.parents[0],f.parent);
 assert.match(object.message,/^WEB-221: implement behavior\n\nSingularity-Flow-Transaction: test\n$/u);
 const retained=await operationForCommit(f.root,result.commit),discovery=await readCommitPolicyRecord(f.root,retained.discovery),issued=await readCommitPolicyRecord(f.root,retained.plan);
 assert.equal(discovery.discoverySha256,issued.discoverySha256);assert.equal(discovery.observationsOnly,true);
 assert.ok(discovery.configuration.some(setting=>setting.name==='user.name'&&setting.origin));
 assert.equal(f.git(f.root,['diff','--cached']),before);
 await advance(f,result);assert.equal(f.git(f.root,['rev-parse','HEAD']),result.commit);
 const resumed=await createRepositoryPolicyCommit(f.root,request(f,tree));assert.equal(resumed.commit,result.commit);assert.equal(resumed.reused,true);assert.equal(resumed.refAdvanced,true);
});

test('lost response reuses the actual retained object and refuses policy/ref drift',async t=>{
 const f=await rcpFixture(t),tree=await f.candidate();
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree),{fault:()=>{throw Error('lost response');}}),/lost response/u);
 const resumed=await createRepositoryPolicyCommit(f.root,request(f,tree));assert.equal(resumed.reused,true);
 f.git(f.root,['update-ref',f.ref,f.git(f.root,['rev-parse',`${f.parent}^`]),f.parent]);
 await assert.rejects(advance(f,resumed),{code:'RCP_PLAN_STALE'});
});

test('ordinary direct writer cannot bypass an enforced owner plan',async t=>{
 const f=await rcpFixture(t),tree=await f.candidate();
 await createRepositoryPolicyCommit(f.root,request(f,tree));
 assert.throws(()=>run('git',['commit-tree',tree,'-p',f.parent,'-m','borrowed'],{cwd:f.root}),{code:'RCP_OWNER_ADMISSION_REQUIRED'});
 assert.throws(()=>run('git',['update-ref',f.ref,f.parent],{cwd:f.root}),{code:'RCP_OWNER_ADMISSION_REQUIRED'});
 const {runRemoteGitAsync}=await import('../src/git-execution.mjs');
 await assert.rejects(runRemoteGitAsync(['update-ref',f.ref,f.parent],{cwd:f.root,operation:'local-read'}),{code:'RCP_OWNER_ADMISSION_REQUIRED'});
});

function nativePolicy(script,transform=null){return registeredRcpPolicy({validation:{adapter:'native-git',profile:'native-v1'},profiles:{'native-v1':{schemaVersion:1,adapter:'native-git',platforms:['darwin','win32','linux'],checks:[],coverage:[{stage:'commit-msg',path:'@hooks/commit-msg',sha256:`sha256:${createHash('sha256').update(script).digest('hex')}`,checks:[]}],native:{context:'original-worktree-private-git',gitDirectory:'candidate-compatible',...(transform?{messageTransform:transform}:{})}}}});}
async function hook(f,script){const folder=path.join(f.root,'.git/hooks');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'commit-msg'),script,{mode:0o755});}

test('native Git runs exact adopted hooks in the real root, imports the object, and never advances owner HEAD early',async t=>{
 const script='#!/bin/sh\nprintf x >> "$GIT_DIR/invocations"\ngrep -q "^WEB-221: " "$1"\n';
 const f=await rcpFixture(t,nativePolicy(script));await hook(f,script);const tree=await f.candidate();
 const result=await createRepositoryPolicyCommit(f.root,request(f,tree));
 assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 assert.equal(observePolicyCommit(f.root,result.commit).tree,tree);
 await advance(f,result);
 assert.equal((await createRepositoryPolicyCommit(f.root,request(f,tree))).commit,result.commit);
});

test('managed timestamp is produced by the actual hook and reused without suffix accumulation',async t=>{
 const script='#!/bin/sh\nsed "1s/$/ timestamp=$(date +%s)/" "$1" > "$1.next" && mv "$1.next" "$1"\n';
 const transform={producer:'commit-msg',placement:'subject-suffix',delimiter:' ',prefix:'timestamp=',encoding:'unix-seconds',maximumClockSkewSeconds:5};
 const f=await rcpFixture(t,nativePolicy(script,transform));await hook(f,script);const tree=await f.candidate();
 const original=request(f,tree);const a=await createRepositoryPolicyCommit(f.root,original); const b=await createRepositoryPolicyCommit(f.root,original);
 assert.equal(a.commit,b.commit);assert.match(observePolicyCommit(f.root,a.commit).message,/^WEB-221: implement behavior timestamp=[0-9]+\n\nSingularity-Flow-Transaction: test\n$/u);
 assert.equal(original.message.includes('timestamp='),false);
});

test('hook rejection and out-of-scope effects are preserved, without fallback or automatic retry',async t=>{
 const script='#!/bin/sh\nprintf "actual tool failed\\n" >&2\nexit 1\n';
 const f=await rcpFixture(t,nativePolicy(script));await hook(f,script);const tree=await f.candidate();
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),{code:'RCP_MESSAGE_REJECTED'});
 assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),{code:'RCP_REPAIR_REQUIRED'});
});

test('required SSH signatures are verified on the actual retained object and reused unchanged',async t=>{
 const f=await rcpFixture(t,registeredRcpPolicy({signing:{required:true}}));
 const {spawnSync}=await import('node:child_process');
 const key=path.join(f.base,'signer');
 const generated=spawnSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key],{encoding:'utf8',timeout:30000});
 assert.equal(generated.status,0,generated.stderr);
 const allowed=path.join(f.base,'allowed-signers');
 await writeFile(allowed,`author@example.invalid ${await readFile(key+'.pub','utf8')}`);
 f.git(f.root,['config','gpg.format','ssh']);f.git(f.root,['config','user.signingkey',key]);f.git(f.root,['config','gpg.ssh.allowedSignersFile',allowed]);
 const original=request(f,await f.candidate(),'signed-owner');const a=await createRepositoryPolicyCommit(f.root,original);const b=await createRepositoryPolicyCommit(f.root,original);
 assert.equal(a.object.signature,'verified');assert.equal(a.commit,b.commit);assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 await advance(f,a);assert.equal(f.git(f.root,['rev-parse','HEAD']),a.commit);
});

test('native out-of-scope writes remain visible and cannot advance the owner branch',async t=>{
 const script='#!/bin/sh\nprintf "preserved hook output\\n" > unplanned.txt\n';
 const f=await rcpFixture(t,nativePolicy(script));await hook(f,script);const tree=await f.candidate();
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),{code:'RCP_HOOK_EFFECT_OUT_OF_SCOPE'});
 assert.equal(await readFile(path.join(f.root,'unplanned.txt'),'utf8'),'preserved hook output\n');assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),{code:'RCP_OBJECT_RECONCILIATION_REQUIRED'});
});

test('unexpected actual staged tree changes are retained but never admitted',async t=>{
 const script='#!/bin/sh\nblob=$(printf "unexpected\\n" | git hash-object -w --stdin)\ngit update-index --cacheinfo "100644,$blob,source.js"\n';
 const f=await rcpFixture(t,nativePolicy(script));await hook(f,script);const tree=await f.candidate();
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),{code:'RCP_HOOK_INDEX_CHANGED'});
 assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);assert.equal(await readFile(path.join(f.root,'source.js'),'utf8'),'export const value = 2;\n');
});

test('post-commit notification failure reports the existing object and never recreates it',async t=>{
 const script='#!/bin/sh\nexit 0\n',post='#!/bin/sh\nprintf "notification unavailable\\n" >&2\nexit 3\n';
 const policy=nativePolicy(script);policy.profiles['native-v1'].coverage.push({stage:'post-commit',path:'@hooks/post-commit',sha256:`sha256:${createHash('sha256').update(post).digest('hex')}`,checks:[]});
 const f=await rcpFixture(t,policy);await hook(f,script);await writeFile(path.join(f.root,'.git/hooks/post-commit'),post,{mode:0o755});const tree=await f.candidate();let commit;
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),error=>{assert.equal(error.code,'RCP_POST_COMMIT_NOTIFICATION_PENDING');commit=error.details.commit;return true;});
 assert.equal(observePolicyCommit(f.root,commit).tree,tree);assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,tree)),error=>{assert.equal(error.code,'RCP_OBJECT_RECONCILIATION_REQUIRED');assert.equal(error.details.commit,commit);return true;});
});

test('source-normalizing native hooks consume one finite budget across different owner attempts',async t=>{
 const script='#!/bin/sh\nprintf "export const value = 3;\\n" > source.js\ngit add source.js\n';
 const f=await rcpFixture(t,nativePolicy(script));await hook(f,script);
 for(let i=0;i<2;i++)await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,await f.candidate(),`normalizer-${i}`)),{code:'RCP_CANDIDATE_CHANGED'});
 await assert.rejects(createRepositoryPolicyCommit(f.root,request(f,await f.candidate(),'normalizer-third')),{code:'RCP_NORMALIZATION_BUDGET_EXHAUSTED'});
 assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
});

test('Git -C and environment repository selectors cannot evade the central write barrier',async t=>{
 const f=await rcpFixture(t);const tree=await f.candidate();await createRepositoryPolicyCommit(f.root,request(f,tree));
 assert.throws(()=>run('git',['-C',f.root,'commit-tree',tree,'-p',f.parent,'-m','bypass'],{cwd:f.base}),{code:'RCP_OWNER_ADMISSION_REQUIRED'});
 assert.throws(()=>run('git',['commit-tree',tree,'-p',f.parent,'-m','bypass'],{cwd:f.base,env:{...process.env,GIT_DIR:path.join(f.root,'.git'),GIT_WORK_TREE:f.root}}),{code:'RCP_OWNER_ADMISSION_REQUIRED'});
});

test('a fresh process preserves explicit off mode and recognizes an escaped YAML policy key',async t=>{
 const {spawnSync}=await import('node:child_process');
 const f=await rcpFixture(t,{schemaVersion:1,mode:'off'}),tree=await f.candidate();
 const code=`import {run} from ${JSON.stringify(new URL('../src/util.mjs',import.meta.url).href)};
  try{run('git',['commit-tree',process.argv[2],'-p',process.argv[3],'-m','compatible work'],{cwd:process.argv[1]});console.log('compatible');}
  catch(error){console.log(error.code);process.exitCode=2;}`;
 const invoke=()=>spawnSync(process.execPath,['--input-type=module','-e',code,f.root,tree,f.parent],{encoding:'utf8',timeout:30000});
 const off=invoke();assert.equal(off.status,0,off.stderr);assert.match(off.stdout,/compatible/u);
 const file=path.join(f.root,'singularity/workflow.yml'),text=await readFile(file,'utf8');
 await writeFile(file,text.replace('commitPolicy:', '"commit\\u0050olicy":').replace('mode: off','mode: enforce'));
 const enforced=invoke();assert.equal(enforced.status,2,enforced.stderr);assert.match(enforced.stdout,/RCP_OWNER_ADMISSION_REQUIRED/u);
 assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
});
