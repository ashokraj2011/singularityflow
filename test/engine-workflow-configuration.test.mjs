import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { createWorkflowConfigurationCompiler, mergePhaseOverride } from '../src/kernel/workflow-configuration.mjs';
import { mergePhaseOverride as compatibilityMerge } from '../src/phase-overrides.mjs';
import { captureConfigurationCompiler } from './helpers/configuration-compiler-capture.mjs';

const capture=captureConfigurationCompiler();
let native,composition;
try { native=await import('../src/config.mjs');composition=capture.value; }
finally { capture.close(); }
const {configurationCaseResults}=await import('./helpers/workflow-configuration-cases.mjs');
const baseline=JSON.parse(await readFile(new URL('./fixtures/engine-configuration/native-v1.json',import.meta.url),'utf8'));
const source=YAML.parse(await readFile(new URL('../templates/workflow.yml',import.meta.url),'utf8'));

test('43 pre-extraction results preserve every normalized byte, all 18 workflows and exact refusals',async()=>{
  assert.deepEqual(await configurationCaseResults(),baseline.results);
});

test('moved compiler rule bodies retain their native syntax except the explicit runtime loader handoff',async()=>{
  const text=await readFile(new URL('../src/kernel/workflow-configuration.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('workflow-configuration.mjs',text,ts.ScriptTarget.Latest,true);
  const printer=ts.createPrinter({removeComments:true}),found=new Set();
  const visit=node=>{
    if(ts.isFunctionDeclaration(node)&&baseline.syntax[node.name?.text]) {
      let body=node.body.getText(ast);
      if(node.name.text==='validateDefinition') {
        assert.equal(body.split('normalizeCommitPolicyRuntime(definition.git.commitPolicy)').length,2);
        body=body.replace('    definition.git.commitPolicy = normalizeCommitPolicyRuntime(definition.git.commitPolicy);',baseline.runtimeBoundary);
      }
      const parsed=ts.createSourceFile('body.mjs','function original() '+body,ts.ScriptTarget.Latest,true);
      const normalized=printer.printNode(ts.EmitHint.Unspecified,parsed.statements[0].body,parsed);
      assert.equal(createHash('sha256').update(normalized).digest('hex'),baseline.syntax[node.name.text],node.name.text);
      found.add(node.name.text);
    }
    ts.forEachChild(node,visit);
  };
  visit(ast);assert.deepEqual([...found].sort(),Object.keys(baseline.syntax).sort());
  assert.equal(mergePhaseOverride,compatibilityMerge);
  assert.equal(native.mergePhaseOverride,mergePhaseOverride);
  for(const [name,fn]of Object.entries(composition.compiler))if(Object.hasOwn(native,name)&&name!=='validateDefinition')assert.equal(fn,native[name],name);
  assert.equal(native.validateDefinition.length,composition.compiler.validateDefinition.length);
});

test('compiler construction refuses missing, inherited, accessor and unrecognized collaborators',()=>{
  const code={code:'ENGINE_CONFIGURATION_COMPILER_INVALID'};
  for(const missing of Object.keys(composition.dependencies)) {
    const dependencies={...composition.dependencies};delete dependencies[missing];
    assert.throws(()=>createWorkflowConfigurationCompiler(dependencies),code,missing);
  }
  assert.throws(()=>createWorkflowConfigurationCompiler(Object.create(composition.dependencies)),code);
  assert.throws(()=>createWorkflowConfigurationCompiler({...composition.dependencies,ready:true}),code);
  let called=false;const accessor={...composition.dependencies};
  Object.defineProperty(accessor,'normalizeCommitPolicyRuntime',{enumerable:true,get(){called=true;throw new Error('do not execute');}});
  assert.throws(()=>createWorkflowConfigurationCompiler(accessor),code);assert.equal(called,false);
  const extra={...composition.dependencies,[Symbol('hidden')]:true};assert.throws(()=>createWorkflowConfigurationCompiler(extra),code);
  assert.throws(()=>createWorkflowConfigurationCompiler({...composition.dependencies,normalizeCommitPolicyRuntime:null}),code);
});

test('a compiler captures its trusted collaborators and does not read mutable construction state later',()=>{
  const dependencies={...composition.dependencies},compiler=createWorkflowConfigurationCompiler(dependencies);
  for(const name of Object.keys(dependencies))dependencies[name]=()=>{throw new Error('late collaborator replacement');};
  const definition=compiler.validateDefinition(structuredClone(source));
  assert.deepEqual(compiler.resolveWorkType(definition,'spec-driven-standard'),native.resolveWorkType(native.validateDefinition(structuredClone(source)),'spec-driven-standard'));
  assert.equal(Object.isFrozen(compiler),true);
});

test('shared policy rules cannot be replaced through compiler construction',()=>{
  for(const name of ['normalizeSessionPolicy','isTemplateReference','parseTemplateReference','normalizeTemplateCatalog',
    'resolveTemplate','normalizeReworkLoops','normalizeRepairBudget','normalizeWorkTypeIntelligence','assertModelTask',
    'normalizeHarnessImports','normalizeContextPolicy','normalizeTestRuntime','normalizeTokenEconomy',
    'normalizeCodeDeliveryPolicy','normalizeSpecPolicy','assertDocumentStoragePolicy',
    'normalizeAdhocPolicy','normalizeAutoPolicy','normalizeAutoWorkTypePolicy','normalizeIntegrations',
    'normalizeMcpServers','normalizePhaseMcpPolicy','normalizeStepActions','pinStepActions','validateMcpAgentTools']) {
    assert.equal(Object.hasOwn(composition.dependencies,name),false,name);
    assert.throws(()=>createWorkflowConfigurationCompiler({...composition.dependencies,[name]:()=>({ready:true})}),
      {code:'ENGINE_CONFIGURATION_COMPILER_INVALID'},name);
  }
});

test('definition data cannot substitute a policy validator or waive convergence approval',()=>{
  const definition=structuredClone(source);definition.phases.convergence.approval={mode:'none'};
  definition.normalizeApprovalPolicy=()=>({mode:'required'});definition.ready=true;
  assert.throws(()=>composition.compiler.validateDefinition(definition),{code:'CONVERGENCE_HUMAN_APPROVAL_REQUIRED'});
});

test('saved reviewer catalogs preserve reviewer availability and independent author constraints',async()=>{
  const definition=structuredClone(source);
  const policies=Object.values(definition.workTypes).map(type=>type.sourceReview).filter(policy=>policy?.mode==='enforce');
  assert.ok(policies.length>0);
  const {parseAgentDependencies}=await import('../src/agent-document-parser.mjs');
  const agents=new Map();
  for(const directory of [new URL('../plugin/agents/',import.meta.url),new URL('../templates/agents/',import.meta.url)]) {
    for(const name of (await readdir(directory)).filter(name=>name.endsWith('.agent.md'))) {
      const agent=parseAgentDependencies(await readFile(new URL(name,directory),'utf8'),{source:name});
      if(!agents.has(agent.id))agents.set(agent.id,agent);
    }
  }
  definition.agentCatalog=[...agents.values()];
  const reviewer=definition.agentCatalog.findIndex(agent=>agent.id===policies[0].reviewerAgent);assert.ok(reviewer>=0);
  assert.doesNotThrow(()=>composition.compiler.validateDefinition(structuredClone(definition),{storyBootstrap:true}));
  const unavailable=structuredClone(definition);unavailable.agentCatalog[reviewer].metadata={};
  assert.throws(()=>composition.compiler.validateDefinition(unavailable,{storyBootstrap:true}),{code:'SOURCE_REVIEW_AGENT_UNAVAILABLE'});
  const collision=structuredClone(definition);
  collision.agentCatalog[reviewer].defaultFor=[policies[0].phases[0]];
  assert.throws(()=>composition.compiler.validateDefinition(collision,{storyBootstrap:true}),{code:'SOURCE_REVIEW_AUTHOR_COLLISION'});
});

test('relative path interpretation is an explicit host fact for both platform grammars',()=>{
  for(const [grammar,absolute]of [[path.posix,'/outside'],[path.win32,'C:\\outside']]) {
    const compiler=createWorkflowConfigurationCompiler({...composition.dependencies,
      pathSyntax:Object.freeze({...composition.dependencies.pathSyntax,grammar:grammar.sep==='\\'?'win32':'posix',
        isAbsolute:grammar.isAbsolute,normalize:grammar.normalize,parse:grammar.parse,
        toPosix:value=>value.split(grammar.sep).join('/')})});
    const definition=structuredClone(source);definition.templatesRoot=absolute;
    assert.throws(()=>compiler.validateDefinition(definition),/repository-relative path/);
  }
});

test('the opt-in runtime policy loader is invoked at its original checkpoint and preserves the real error',()=>{
  const failure=new Error('runtime loader failure');failure.code='NATIVE_POLICY_LOAD_FAILED';let reads=0;
  const compiler=createWorkflowConfigurationCompiler({...composition.dependencies,commitPolicyRuntime:Object.freeze({
    ...composition.dependencies.commitPolicyRuntime,assertAvailable(){assert.equal(arguments.length,0);reads++;throw failure;}})});
  compiler.validateDefinition(structuredClone(source));assert.equal(reads,0);
  const definition=structuredClone(source);definition.git.commitPolicy={};
  assert.throws(()=>compiler.validateDefinition(definition),error=>error===failure);assert.equal(reads,1);
});
