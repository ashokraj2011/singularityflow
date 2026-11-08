import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as kernel from '../src/kernel/artifact-content.mjs';
import * as native from '../src/config.mjs';
import { namespaceConfigurationFixture } from './helpers/namespace-configuration-fixture.mjs';
import { seededNamespaceConfiguration } from './helpers/namespace-seeded-configuration.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const names=['ARTIFACT_TEMPLATE_TOKENS','normalizeArtifactTemplateCompatibility','validateArtifactTemplateText','renderArtifactTemplateText'];

test('artifact templates have one pure content owner with unchanged native function bodies and exports',async()=>{
  const captured=JSON.parse(await readFile(new URL('./fixtures/engine-artifact-template/native-v1.json',import.meta.url),'utf8'));
  const source=await readFile(new URL('../src/kernel/artifact-content.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('core',source,ts.ScriptTarget.Latest,true);
  for(const name of names) {
    assert.equal(native[name],kernel[name],name);
    const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
    const value=fn?.body??ast.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations])
      .find(node=>node.name.getText(ast)===name)?.initializer;
    assert.ok(value,name);assert.equal(sha(value.getText(ast)),captured.bodies[name],name);
  }
});

test('every shipped workflow template renders the captured native bytes through the portable content rules',async t=>{
  const captured=JSON.parse(await readFile(new URL('./fixtures/engine-artifact-template/native-v1.json',import.meta.url),'utf8'));
  const f=await namespaceConfigurationFixture(t),{source,expected}=await seededNamespaceConfiguration(f);
  const templates=new Map();
  for(const item of source.templates)templates.set(item.path,Buffer.from((await f.content.read(f.scope,item.body)).data).toString('utf8'));
  const observations=[];
  for(const [workType,workflow] of Object.entries(expected))for(const phase of workflow.phases) {
    const path=`${source.definition.templatesRoot}/${phase.template}`,text=templates.get(path);
    assert.equal(typeof text,'string',path);
    const variables={...captured.variables,workType};
    observations.push({workType,phase:phase.id,template:path,sourceSha256:sha(text),renderedSha256:sha(kernel.renderArtifactTemplateText(text,phase,variables))});
  }
  assert.deepEqual(observations,captured.results);assert.equal(Object.keys(expected).length,18);assert.equal(observations.length,85);
});

test('unsupported artifact tokens keep their exact diagnostic and legacy namespace compatibility remains narrow',()=>{
  assert.equal(kernel.normalizeArtifactTemplateCompatibility('{{WORK_ID}} [{{WORK_ID}}:REQ-001]',{id:'T-1'}),'T-1 [T-1:REQ-001]');
  assert.throws(()=>kernel.renderArtifactTemplateText('{{unsupported}} {{unknown}} {{unsupported}}',{id:'scope'},{}),{
    message:"Artifact template for phase 'scope' contains unsupported token(s): {{unsupported}}, {{unknown}}. Supported tokens: {{work.id}}, {{work.title}}, {{work.type}}, {{phase.id}}, {{phase.label}}, {{inputs}}."
  });
  const rendered=kernel.renderArtifactTemplateText('{{work.id}} {{work.title}} {{work.type}} {{phase.id}} {{phase.label}} {{inputs}}',
    {id:'team-review',label:'Team review'},{id:'T-1',title:'A converter',workType:'feature',inputs:'Retained input'});
  assert.equal(rendered,'T-1 A converter feature team-review Team review Retained input');
});
