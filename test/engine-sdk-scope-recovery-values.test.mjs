/** Public scope/recovery entries are qualified from the actual offline-installed archive. */
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {copyFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {buildEngineSdk} from '../scripts/build-engine-sdk.mjs';
import {resolvePlatformProcess} from '../src/platform-process.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('offline scope and recovery values run without host I/O and typecheck under NodeNext', {timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-sdk-decision-values-')),artifact=path.join(directory,'package'),
    consumer=path.join(directory,'consumer'),archives=path.join(directory,'archives'),tmp=path.join(directory,'tmp');
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  for(const folder of [artifact,consumer,archives,tmp])await mkdir(folder);
  const env={...isolatedTestEnvironment(path.join(directory,'machine')),TMPDIR:tmp};
  function child(executable,args,cwd,options={}){const result=spawnSync(executable,args,{cwd,env,encoding:'utf8',timeout:60000,...options});
    assert.equal(result.status,0,JSON.stringify({error:result.error?.message,stderr:result.stderr,stdout:result.stdout}));return result.stdout;}
  function npm(args,cwd){const launch=resolvePlatformProcess('npm',args);return child(launch.executable,launch.arguments,cwd,launch.spawnOptions);}
  for(const file of ['package.json','README.md'])await copyFile(path.join(root,'packages/engine-sdk',file),path.join(artifact,file));
  await buildEngineSdk({outdir:path.join(artifact,'dist')});
  const packed=JSON.parse(npm(['pack','--offline','--ignore-scripts','--json','--pack-destination',archives],artifact))[0];
  await writeFile(path.join(consumer,'package.json'),'{"private":true,"type":"module"}');
  npm(['install',path.join(archives,packed.filename),'--offline','--ignore-scripts','--no-audit','--no-fund'],consumer);
  await writeFile(path.join(consumer,'values.mjs'),`
import assert from 'node:assert/strict';import path from 'node:path';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';
const digests=Object.freeze({profile:'sflow-text-digests/sha256-utf8-v1',sha256Utf8:text=>createHash('sha256').update(text).digest('hex')});
const paths=Object.freeze({profile:'sflow-configuration-path-syntax/v2',grammar:path.sep==='\\\\'?'win32':'posix',isAbsolute:path.isAbsolute,normalize:path.normalize,parse:path.parse,
 posixIsAbsolute:path.posix.isAbsolute,posixNormalize:path.posix.normalize,posixBasename:path.posix.basename,posixDirname:path.posix.dirname,posixRelative:path.posix.relative,
 win32IsAbsolute:path.win32.isAbsolute,toPosix:value=>value.split(path.sep).join('/')});
const hook=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:'))throw Error('Pure entry attempted host I/O: '+specifier);return next(specifier,context);}});
const scope=await import('@singularity-flow/engine-sdk/scope'),recovery=await import('@singularity-flow/engine-sdk/testing/recovery'),plans=await import('@singularity-flow/engine-sdk/plans'),constitution=await import('@singularity-flow/engine-sdk/constitution');
const standing=constitution.constitutionValuePolicies(digests,Object.freeze({profile:constitution.CONSTITUTION_SYNTAX_PROFILE,parse:JSON.parse}));
const parsed=standing.parseConstitution('---\\n{"articles":[{"id":"ART-001","type":"judged","level":"must","evidenceRequired":true}]}\\n---\\n## [ART-001] Observable behavior\\nRetain acceptance evidence.');
assert.equal(parsed.articles[0].id,'ART-001');assert.equal(standing.citedArticleIds('## Constitution articles\\n[ART-001]')[0],'ART-001');
assert.equal(constitution.CONSTITUTION_RECORD_SCHEMA.currentVersion,1);
assert.throws(()=>standing.expiredExceptions([]),error=>Boolean(error.message));
const statements=scope.scopeStatementPolicies(digests),original=statements.extractNormativeStatements('The converter must reject a negative integer.',{sourceId:'story'});
assert.equal(original.length,1);assert.match(original[0].statementSha256,/^[a-f0-9]{64}$/u);
const inventory=scope.scopeInventoryPolicies(digests).buildScopeInventoryValue({workItem:{id:'example'}},{sources:[{
 id:'story',kind:'story',sha256:'a'.repeat(64),readable:true,statements:original}],clauses:[],decisions:[]});
assert.equal(inventory.summary.unresolved,1);assert.equal(inventory.structurallyComplete,false);
const rules=recovery.testRecoveryPolicies(digests);assert.equal(rules.TRP_EVALUATOR_VERSION,'trp/1.0');
assert.equal(rules.trpDigest({b:2,a:1}),rules.trpDigest({a:1,b:2}));assert.throws(()=>rules.validateTrpRecord({}),error=>Boolean(error.code));
const corrected=plans.planCorrectionPolicies(paths,digests).evidenceCorrectionProjection('W:AC-001',{tests:['test/value.mjs']},'stories/W/evidence/screen.png','visual');
assert.equal(corrected.claim.fulfillment,'evidence');assert.equal(corrected.contract.slots[1].role,'supporting');
assert.equal(plans.planCorrectionPolicies(paths,digests).applyPlanCorrections(null,{}),null);
hook.deregister();
`);
  child(process.execPath,['values.mjs'],consumer);
  await writeFile(path.join(consumer,'values.mts'),`
import type {SpecificationDigests} from '@singularity-flow/engine-sdk/specifications';
import {scopeStatementPolicies,scopeInventoryPolicies} from '@singularity-flow/engine-sdk/scope';
import {testRecoveryPolicies,type TrpGateInput} from '@singularity-flow/engine-sdk/testing/recovery';
import {createNamespaceEngine} from '@singularity-flow/engine-sdk/hosts/namespace-engine';
import {planCorrectionPolicies,type PlanCorrectionOperation} from '@singularity-flow/engine-sdk/plans';
import {constitutionValuePolicies,CONSTITUTION_SYNTAX_PROFILE,type ConstitutionArticle} from '@singularity-flow/engine-sdk/constitution';
import type {VerificationPathSyntax} from '@singularity-flow/engine-sdk/specifications';
declare const digests:SpecificationDigests,engine:ReturnType<typeof createNamespaceEngine>;
declare const paths:VerificationPathSyntax;
const standing=constitutionValuePolicies(digests,Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,parse:JSON.parse}),{pathSeparator:'/'});
const parsed:ConstitutionArticle[]=standing.parseConstitution('---\\n{}\\n---').articles;void parsed;
standing.generationPlan('---\\n{}\\n---',{});
// @ts-expect-error syntax is a versioned primitive, not a policy-readiness assertion
constitutionValuePolicies(digests,Object.freeze({profile:CONSTITUTION_SYNTAX_PROFILE,ready:true}));
planCorrectionPolicies(paths,digests).applyPlanCorrections({}, {}, {evidenceRoot:'stories/example/evidence'},[]);
const row:PlanCorrectionOperation={op:'add-test',clauseId:'W:AC-001',test:'test/value.mjs'};void row;
await engine.run('plan.correction.context',{operations:[row],reason:'Inspect the actual row correction.'});
await engine.run('plan.correction.record',{operationId:'correct-exact-row',operations:[row],reason:'Record this exact reviewed row.',expectedPreview:'sha256:example'});
// @ts-expect-error a namespace correction requires its exact reviewed context
await engine.run('plan.correction.record',{operationId:'no-review',operations:[row],reason:'No review digest was supplied.'});
// @ts-expect-error correction operations cannot grant approval
const invalid:PlanCorrectionOperation={op:'approve',clauseId:'W:AC-001'};void invalid;
// @ts-expect-error replacing an exact approved path requires both reviewed locations
await engine.run('plan.correction.context',{operations:[{op:'replace-location',clauseId:'W:AC-001'}],reason:'Incomplete path correction.'});
const statements=scopeStatementPolicies(digests).extractNormativeStatements('Reject negative input.',{sourceId:'story'});
scopeInventoryPolicies(digests).buildScopeInventoryValue({}, {sources:[{id:'story',kind:'story',sha256:null,readable:true,statements}],clauses:[]});
const recovery=testRecoveryPolicies(digests);recovery.trpDigest({observed:true});
await engine.run('scope.context',{workId:'example'});
await engine.run('decision.scope',{operationId:'review-scope',item:'SRI-example',disposition:'included',clauseIds:['EXAMPLE:AC-001'],reason:'A human reviewed the exact clause.'});
// @ts-expect-error structural callbacks cannot be serialized approval flags
const bad:TrpGateInput={policy:{},agreement:null,subject:{},operation:'publish',at:'time',verifyAuthority:true};
// @ts-expect-error operation identity is a string
await engine.run('decision.scope',{operationId:true});
// @ts-expect-error human identity comes from access, never the request
await engine.run('decision.scope',{operationId:'x',actor:'model'});
void bad;
`);
  await writeFile(path.join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,
    noEmit:true,types:[],lib:['ES2023','DOM']},include:['values.mts']}));
  child(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],consumer);
});
