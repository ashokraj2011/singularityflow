import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {stageCli} from '../scripts/vscode-dev.mjs';
import {isolatedTestEnvironment} from '../scripts/test-machine-state.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('the actual staged VS Code CLI retains the complete native evidence closure and original oracle',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-native-evidence-package-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5}));
  const staged=await stageCli({rootDir:root,extensionDir:directory}),capture=await readFile(new URL('./fixtures/native-evidence-evaluation-v1.json',import.meta.url),'utf8'),
    script=path.join(directory,'check-native-evidence.mjs');
  await writeFile(script,[
    "import assert from 'node:assert/strict';",
    'const {evaluateEvidence}=await import('+JSON.stringify(pathToFileURL(path.join(staged,'src/evidence/evaluate.mjs')).href)+');',
    'const {evidenceGraph}=await import('+JSON.stringify(pathToFileURL(path.join(staged,'src/evidence/graph.mjs')).href)+');',
    'const captured='+capture+';',
    'for(const row of captured.cases){assert.deepEqual(evaluateEvidence(row.graph,row.options),row.result);assert.equal(evidenceGraph(row.graph).inputSha256,row.graphSha256);}',
    'console.log(JSON.stringify({cases:captured.cases.length}));'
  ].join('\n'));
  const result=spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8',timeout:60000,
    env:{...isolatedTestEnvironment(path.join(directory,'machine')),PATH:''}});
  assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
  assert.equal(JSON.parse(result.stdout).cases,14);
});
