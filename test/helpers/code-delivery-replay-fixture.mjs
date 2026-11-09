/** Real committed source, exact witnesses and durable reports for receipt-replay compatibility. */
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {buildRepositoryChangeSet} from '../../src/repository-change-set.mjs';
import {buildTestExecutionReceipt,replayTestReports} from '../../src/code-delivery-tests.mjs';
import {bindingsDigest} from '../../src/implementation-bindings.mjs';
import {canonicalJson} from '../../src/foundation/record-schema.mjs';
import {scanJavaScriptDeclarations} from '../../src/verification/javascript-declarations.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function codeDeliveryReplayFixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-code-replay-'));
  const close=()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  try{
    const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'}}).trim();
    git('init','-q','-b','main');git('config','user.name','Example fixture');git('config','user.email','fixture@example.test');git('config','commit.gpgsign','false');
    await mkdir(path.join(root,'src'));await mkdir(path.join(root,'test'));
    await writeFile(path.join(root,'src/app.js'),'export const convert = value => value;\n');
    git('add','.');git('commit','-qm','baseline');const base=git('rev-parse','HEAD');
    const explanation='returns the approved hexadecimal representation';
    const source=`// @clause:REPLAY:REQ-001 ${explanation}\nexport const convert = value => value.toString(16);\n`;
    const testSource="// @ac:REPLAY:AC-001\ntest('hex', () => { expect(convert(15)).toBe('f'); });\n";
    await writeFile(path.join(root,'src/app.js'),source);await writeFile(path.join(root,'test/app.test.js'),testSource);
    await symlink('src/app.js',path.join(root,'link'));
    const changeSet=await buildRepositoryChangeSet(root,{baseCommit:base,subject:{workId:'replay',phase:'implementation',generation:1}});
    const workingStateDigest='b'.repeat(64),attemptId='TA-00000000000000000001',commandId='unit';
    const raw=Buffer.from(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,
      testResults:[{name:'/repo/test/app.test.js',assertionResults:[{title:'hex',fullName:'hex',ancestorTitles:[],status:'passed'}]}]}));
    const report={path:`singularity/work-items/replay/context/code-delivery/tests/raw/${hash(raw)}.bin`,sha256:hash(raw),bytes:raw.length};
    const receiptPath=`singularity/work-items/replay/context/code-delivery/tests/attempts/implementation/${attemptId}.json`;
    const command={id:commandId,argv:['npm','test'],workingDirectory:'.',affectedRoots:['.'],result:{adapter:'jest-json',path:'.sflow/results/unit.json'}};
    const record=buildTestExecutionReceipt(command,{status:'passed',exitCode:0,sourceTreeSha256:workingStateDigest},
      replayTestReports('jest-json',[{contents:raw}]),{attemptId,nonce:'a'.repeat(64),workId:'replay',phase:'implementation',generation:1,rawReports:[report],profile:'jest-static-v2'});
    const changeSetPath='singularity/work-items/replay/context/code-delivery/implementation-gen1-changes.json';
    for(const [file,bytes]of [[changeSetPath,canonicalJson(changeSet)],[receiptPath,canonicalJson(record)],[report.path,raw]]){
      await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),bytes);
    }
    git('add','.');git('commit','-qm','retained generation and test evidence');
    const generationCommit=git('rev-parse','HEAD'),generationTree=git('rev-parse','HEAD^{tree}');
    const declaration=scanJavaScriptDeclarations(testSource,{sourcePath:'test/app.test.js',framework:'vitest'}).declarations[0];
    const explanations=[{clauseId:'REPLAY:REQ-001',regions:[],explanation:{text:explanation,path:'src/app.js',line:1}}];
    const receipt={schemaVersion:2,kind:'code-delivery',status:'ready',workId:'replay',phase:'implementation',generation:1,
      tree:{generationCommit,generationTree,workingStateDigest},
      changeSet:{path:changeSetPath,digest:changeSet.digest,sourcePaths:['src/app.js'],testPaths:['test/app.test.js'],deletedSourcePaths:[]},
      traceability:{required:['REPLAY:AC-001'],bound:['REPLAY:AC-001'],bindings:[{clauseId:'REPLAY:AC-001',commandId,testSource:'test/app.test.js'}],
        witnesses:[{...declaration,testSource:'test/app.test.js',clauseId:'REPLAY:AC-001',profile:'vitest-static-v2',identity:{framework:'vitest'}}],
        sourceRequired:[{clauseId:'REPLAY:REQ-001',expectedPaths:['src/app.js']}],
        sourceBindings:[{clauseId:'REPLAY:REQ-001',sourcePath:'src/app.js',line:1,tag:'clause'}]},
      implementationBindings:{bindings:explanations,bindingsSha256:bindingsDigest(explanations)},
      testExecutions:[{commandId,attemptId,receiptPath,receiptSha256:hash(canonicalJson(record))}],model:{assurance:'unavailable'}};
    return {root,receipt,record,raw,report,source,testSource,changeSet,git,close,
      policy:{sourceBindingPolicy:'enforce',symlinkPolicy:'allow',evidenceCommit:generationCommit}};
  }catch(error){await close();throw error;}
}

/** Vary rule inputs only; the retained source and reports remain the original committed bytes. */
export function codeDeliveryReplayCases(){
  const rows=[],add=(id,edit=()=>{})=>rows.push({id,edit});
  add('ready');add('legacy-string-version',r=>r.schemaVersion='2');add('future-version',r=>r.schemaVersion=3);add('wrong-kind',r=>r.kind='other');
  add('not-ready',r=>r.status='partial');add('missing-tree',r=>delete r.tree);add('different-tree',r=>r.tree.generationTree='0'.repeat(40));
  add('missing-change-set',r=>delete r.changeSet.path);add('different-change-set',r=>r.changeSet.digest='sha256:'+'0'.repeat(64));
  add('protected-source',(r,p)=>p.protectedPaths=['src/**']);add('test-only-boundary',(r,p)=>p.sourceBoundary='test-automation');
  add('symlink-refused',(r,p)=>p.symlinkPolicy='reject');
  add('binding-digest',r=>r.implementationBindings.bindingsSha256='sha256:'+'0'.repeat(64));
  add('binding-shape',r=>r.implementationBindings.bindings={});
  add('binding-clause',r=>r.implementationBindings.bindings[0].clauseId='invalid');
  add('binding-explanation',r=>r.implementationBindings.bindings[0].explanation.text='a different explanation');
  add('binding-line',r=>r.implementationBindings.bindings[0].explanation.line=2);
  for(const fulfillment of ['existing','evidence','removed','configuration','document','unknown'])for(const name of ['src/app.js','absent','../outside','link']){
    add(`fulfillment-${fulfillment}-${name}`,(r,p,f)=>r.fulfillment={obligations:[{clauseId:'REPLAY:REQ-001',fulfillment,
      paths:[{path:name,state:fulfillment==='removed'?'absent':['configuration','document'].includes(fulfillment)?'changed':'present',sha256:hash(f.source)}]}]});
  }
  add('missing-acceptance',r=>r.traceability.missing=['REPLAY:AC-001']);add('ambiguous-acceptance',r=>r.traceability.ambiguous=['REPLAY:AC-001']);
  add('unbound-acceptance',r=>r.traceability.bound=[]);add('wrong-command',r=>r.traceability.bindings[0].commandId='other');
  add('witness-digest',r=>r.traceability.witnesses[0].declarationSha256='0'.repeat(64));
  add('witness-clause',r=>r.traceability.witnesses[0].clauseId='REPLAY:AC-002');
  add('source-shape',r=>r.traceability.sourceRequired={});add('source-clause',r=>r.traceability.sourceRequired[0].clauseId='invalid');
  add('source-path',r=>r.traceability.sourceBindings[0].sourcePath='../outside');add('source-line',r=>r.traceability.sourceBindings[0].line=2);
  add('source-not-delivered',r=>r.changeSet.sourcePaths=[]);add('source-required-missing',r=>r.traceability.sourceBindings=[]);
  add('source-read-policy-off',(r,p)=>{delete r.traceability.sourceRequired;delete r.traceability.sourceBindings;p.sourceBindingPolicy='off';});
  add('execution-missing',r=>r.testExecutions=[]);add('attempt-identity',r=>r.testExecutions[0].attemptId='other');
  add('attempt-digest',r=>r.testExecutions[0].receiptSha256='0'.repeat(64));add('candidate-mismatch',r=>r.tree.workingStateDigest='c'.repeat(64));
  add('attempt-unavailable',r=>r.testExecutions[0].receiptPath='missing/attempt.json');
  add('attempt-key-mismatch',r=>r.testExecutions[0].commandId='other');
  add('minimum-discovered',(r,p)=>p.minimumDiscovered=2);add('minimum-passed',(r,p)=>p.minimumPassed=2);
  add('trp-without-context',r=>r.testExecutions=[{kind:'phase-validation-observation',commandId:'unit',status:'failed'}]);
  add('risk-without-context',r=>r.testExecutions[0].testRunRisk={id:'risk'});
  add('auto-without-binding',r=>r.autoCandidate={});
  for(const assurance of [undefined,'unavailable','observed','host-observed','provider-reported','policy-selected','future']){
    for(const required of [undefined,false,true])add(`model-${assurance}-${required}`,(r,p)=>{r.model={assurance,required};p.minimumModelAssurance='provider-reported';});
  }
  add('model-minimum',r=>r.model.minimumAssurance='policy-selected');
  add('corner-case-required',(r,p)=>p.cornerCasePolicy='enforce');add('assertions-required',(r,p)=>p.assertionAdequacyPolicy='enforce');
  add('matrix-digest',r=>r.cornerCaseMatrix={status:'partial',matrixSha256:'sha256:'+'0'.repeat(64)});
  return rows;
}

export function receiptReplayProjection(result){return {valid:result.valid,errors:result.errors,hasChangeSet:Boolean(result.changeSet),
  executions:result.executions?.map(({commandId,status,tests})=>({commandId,status,tests}))??null};}
