import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as auto from '../src/kernel/auto-policy.mjs';
import * as adhoc from '../src/kernel/adhoc-policy.mjs';
import * as mcp from '../src/kernel/mcp-policy.mjs';
import * as actions from '../src/kernel/step-action-policy.mjs';
import {executionIntegrationPolicyResults,policyModules} from './helpers/execution-integration-policy-cases.mjs';

const baseline=JSON.parse(await readFile(new URL('./fixtures/engine-execution-integration-policies/native-v1.json',import.meta.url),'utf8'));

test('71 native policy outcomes preserve values, mutations and exact refusal details',()=>{
  assert.deepEqual(executionIntegrationPolicyResults(),baseline.results);
  assert.deepEqual(Object.fromEntries(Object.entries(policyModules).map(([family,module])=>[family,Object.keys(module).sort()])),baseline.exports);
});

test('all 46 extracted rule bodies retain their original syntax',async()=>{
  const owners=[...new Set(Object.values(baseline.functions).map(entry=>entry.owner))],seen=new Set(),printer=ts.createPrinter({removeComments:true});
  for(const owner of owners){
    const ast=ts.createSourceFile(owner,await readFile(new URL('../'+owner,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
    for(const node of ast.statements.filter(ts.isFunctionDeclaration)){
      const entry=Object.entries(baseline.functions).find(([key,value])=>value.owner===owner&&key.endsWith(':'+node.name.text));
      assert.ok(entry,owner+':'+node.name.text);
      const [original,expected]=entry;
      assert.equal(createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified,node.body,ast)).digest('hex'),expected.sha256,original);
      seen.add(original);
    }
  }
  assert.deepEqual([...seen].sort(),Object.keys(baseline.functions).sort());
});

test('native aliases retain the exact shared function and constant identities',async()=>{
  for(const [file,entry]of Object.entries(baseline.owners)){
    const native=await import(new URL('../'+file,import.meta.url)),core=await import(new URL('../'+entry.owner,import.meta.url));
    for(const name of entry.exports)assert.equal(native[name],core[name],file+':'+name);
  }
  assert.equal(Array.isArray(auto.AUTO_AUTHORING_TOOLS),true);
  assert.equal(Array.isArray(auto.AUTO_STOP_KINDS),true);
  assert.equal(Object.isFrozen(auto.AUTO_AUTHORING_TOOLS),true);
  assert.equal(Object.isFrozen(adhoc.DEFAULT_ADHOC_POLICY.scope),true);
  assert.equal(Object.isFrozen(actions.INTEGRATION_TARGET_KINDS),true);
});

test('automatic-run tool and stop vocabularies retain their original constant definitions',async()=>{
  const printer=ts.createPrinter({removeComments:true});
  for(const [name,expected]of Object.entries(baseline.constants)){
    const ast=ts.createSourceFile(expected.owner,await readFile(new URL('../'+expected.owner,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
    const variable=ast.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations]).find(node=>node.name.getText(ast)===name);
    assert.ok(variable,name);
    assert.equal(createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified,variable.initializer,ast)).digest('hex'),expected.sha256,name);
  }
});

test('automatic execution limits tighten across repository, workflow and capability policy',()=>{
  const result=auto.effectiveAutoPolicy({enabled:true,ceilings:{maximumTouchedPaths:6}},
    {eligibility:'bounded',ceilings:{maximumTouchedPaths:20}},{maximumTouchedPaths:3});
  assert.equal(result.ceilings.maximumTouchedPaths,3);
  const folded=auto.foldCapabilityAutoPolicy({eligibility:'plan-only',maximumTouchedPaths:4},
    {eligibility:'bounded',maximumTouchedPaths:20});
  assert.equal(folded.eligibility,'plan-only');assert.equal(folded.maximumTouchedPaths,4);
  for(const flag of ['allowPolicyWaivers','allowClarificationAnswers','allowSequenceOverrides','allowScopeExpansion']) {
    assert.throws(()=>auto.normalizeAutoPolicy({execution:{[flag]:true}}),{code:'AUTO_OPERATION_FORBIDDEN'},flag);
  }
  assert.throws(()=>auto.normalizeAutoPolicy({execution:{requireManagedWorktree:false}}),{code:'AUTO_OPERATION_FORBIDDEN'});
});

test('MCP phase and agent constraints remain mandatory before host execution',()=>{
  const servers=mcp.normalizeMcpServers({browser:{agents:['tester'],phases:['verify'],tools:['open','capture']}},
    {agents:['tester'],phases:['draft','verify']});
  assert.throws(()=>mcp.normalizePhaseMcpPolicy({requiredServers:['browser']},{servers,phaseId:'draft'}),/not allowed in the phase/);
  assert.throws(()=>mcp.validateMcpAgentTools({mcpServers:servers,agentCatalog:[{id:'tester',tools:['browser/open']}]}),{code:'MCP_AGENT_TOOLS_MISMATCH'});
  assert.deepEqual(mcp.mcpServersForContext({mcpServers:servers},{agent:'other',phase:'verify'}),[]);
  assert.doesNotThrow(()=>mcp.validateMcpAgentTools({mcpServers:servers,agentCatalog:[{id:'tester',tools:['browser/*']}]}));
});

test('action declarations cannot embed credentials or fire an approval action before approval',()=>{
  assert.throws(()=>actions.normalizeIntegrations({targets:{notify:{kind:'webhook',url:'https://events.example.test',token:'sample'}}}),{code:'INTEGRATION_SECRET_INLINE'});
  assert.throws(()=>actions.normalizeIntegrations({targets:{notify:{kind:'webhook',url:'https://events.example.test',signingSecret:'UNRELATED_TOKEN'}}}),{code:'INTEGRATION_SECRET_NAME_INVALID'});
  assert.deepEqual(actions.stepActionTriggers('phase-approved',{status:'in_progress'}),[]);
  assert.deepEqual(actions.stepActionTriggers('approval-requested',{status:'awaiting_approval'}),['submitted']);
  assert.deepEqual(actions.stepActionTriggers('phase-approved',{status:'approved'}),['approved']);
});
