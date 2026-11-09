import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import {qualityValidationVerdict,qualityReportUsesStdout,phaseChecksResult} from '../src/kernel/phase-checks.mjs';
import {qualityValidationVerdict as previous} from '../src/lifecycle-evidence-policy.mjs';
const packet=JSON.parse(await readFile(new URL('./fixtures/phase-check-packets/native-v1.json',import.meta.url),'utf8'));
function compare(work,entry){if(entry.error)assert.throws(work,cause=>Object.entries(entry.error).every(([key,value])=>(cause[key]??null)===value));
  else assert.deepEqual(work(),entry.value);}
test('the original native verdict rule body and compatibility export keep their existing meaning',async()=>{
  const source=await readFile(new URL('../src/kernel/phase-checks.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('phase-checks.mjs',source,ts.ScriptTarget.Latest,true),fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='qualityValidationVerdict');
  const body=ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}).printNode(ts.EmitHint.Unspecified,fn.body,ast);
  assert.equal(packet.baseline,'bf90a66a2');assert.equal(createHash('sha256').update(body).digest('hex'),packet.qualityBodySha256);assert.equal(previous,qualityValidationVerdict);
  for(const entry of packet.verdicts)compare(()=>qualityValidationVerdict(entry.checks,{required:entry.required}),entry);
});
test('native stdout report capture keeps independently observed POSIX and Windows path grammar results and errors',()=>{
  for(const entry of packet.stdout)compare(()=>qualityReportUsesStdout(entry.policy,path[entry.grammar].basename),entry);
  assert.equal(qualityReportUsesStdout({kind:'compile',argv:['cargo'],result:{adapter:'cargo-json'}},()=>{throw Error('Do not invoke unused syntax.');}),false);
});
test('malformed phase-check port facts fail explicitly instead of being interpreted as passing evidence',()=>{
  const input={workId:'story',phaseId:'review',operationId:'checks'},base={workId:'story',phase:'review',operationId:'checks',generation:1,replayed:false,
    principalId:'author',recordedAt:'2026-11-09T00:00:00.000Z',record:{key:'retained-check',version:'opaque',content:{namespace:'evidence',sha256:'0'.repeat(64),bytes:1}},verdict:'passed'};
  for(const checks of [[null],[{status:'passed'}],[{id:'check',repositoryId:'app',status:'future',requirement:'required'}]])assert.throws(()=>phaseChecksResult(input,{...base,checks}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
