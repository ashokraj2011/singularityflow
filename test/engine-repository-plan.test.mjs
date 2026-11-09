/** New repository identity is explicit; legacy paths never guess their repository. */
import test from 'node:test';import assert from 'node:assert/strict';
import {deriveRepositoryPlan,repositoryPlanValue,repositoryPlanProjection,assertRepositoryPlanSources,repositoryPlanTestLocation} from '../src/engine-compatibility/node-repository-plan.mjs';
const declarations='\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service | `backend` |\n';
const claim=(expectedPaths,tests,extra={})=>({expectedPaths,tests,testDisposition:'applicable',testReason:null,deviation:null,...extra});
const planned={schemaVersion:2,kind:'planned',recordedAt:'2026-11-10T00:00:00.000Z',claims:{
  'STORY:REQ-001':claim(['frontend/src/value.js','backend/src/value.js'],['frontend/test/value.test.js','backend/test/value.test.js']),
  'STORY:REQ-002':claim(['backend/src/server.js'],['backend/test/server.test.js'],{steps:['server-code']}),
  'STORY:AC-001':claim(['singularity/work-items/story/evidence/screen.png'],[],{fulfillment:'evidence',testDisposition:'non-test',verificationCriterion:'STORY:AC-001'})},
  supportingFiles:['frontend/README.md','backend/package.json'],supportingFileDetails:[
    {path:'frontend/README.md',class:'documentation',reason:'Describe the UI contract.'},{path:'backend/package.json',class:'build-configuration',reason:'Declare the pinned test runner.'}]};
test('identical relative filenames remain separate through exact repository projections',()=>{
  const before=structuredClone(planned),p=deriveRepositoryPlan('# Plan\n'+declarations,planned);
  assert.equal(p.format,'sflow-repository-plan/v1');assert.equal(p.schemaVersion,1);assert.deepEqual(planned,before);
  assert.deepEqual(p.roots,[{repositoryId:'app',pathPrefix:'frontend'},{repositoryId:'service',pathPrefix:'backend'}]);
  for(const id of ['app','service'])assert.deepEqual(repositoryPlanProjection(p,id).claims['STORY:REQ-001'].expectedPaths,['src/value.js']);
  assert.equal(repositoryPlanProjection(p,'app').claims['STORY:REQ-002'],undefined);
  assert.deepEqual(repositoryPlanProjection(p,'service').claims['STORY:REQ-002'].steps,['server-code']);
  assert.equal(repositoryPlanProjection(p,'service').claims['STORY:AC-001'],undefined);
  assert.deepEqual(repositoryPlanProjection(p,'app').supportingFiles,['README.md']);assert.equal(Object.hasOwn(p,'approved'),false);
  assert.deepEqual(repositoryPlanTestLocation(p,'backend/test/server.test.js'),{repositoryId:'service',path:'test/server.test.js'});
});
test('legacy plans and fenced or managed examples do not opt into repository identity',()=>{
  assert.equal(deriveRepositoryPlan('# Legacy plan',planned),null);
  assert.equal(deriveRepositoryPlan('```markdown\n'+declarations+'\n```',planned),null);
  assert.equal(deriveRepositoryPlan('<!--\n'+declarations+'\n-->',planned),null);
});
test('a single explicitly named repository can use the original relative paths',()=>{
  const p=deriveRepositoryPlan('## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `.` |',{
    ...planned,claims:{'STORY:REQ-001':claim(['src/app.js'],['test/app.test.js'])},supportingFiles:[],supportingFileDetails:[]});
  assert.deepEqual(p.repositories[0].claims['STORY:REQ-001'].expectedPaths,['src/app.js']);assertRepositoryPlanSources(p,'code',['app']);
});
for(const [name,markdown,change]of [
  ['overlapping roots',declarations.replace('`backend`','`frontend/server`')],
  ['case-ambiguous roots',declarations.replace('`backend`','`FRONTEND`')],
  ['duplicate repository',declarations.replace('| service |','| app |')],
  ['traversal',declarations.replace('`backend`','`../backend`')],
  ['missing header',declarations.replace('Plan root','Source')],
  ['missing divider',declarations.replace('| --- | --- |','| - | - |')],
  ['empty declaration','## Repository roots\n\n| Repository | Plan root |\n| --- | --- |'],
  ['duplicate declaration',declarations+declarations],
  ['unbound application path',declarations,p=>{p.claims['STORY:REQ-001'].expectedPaths.push('unknown/src/value.js');}],
  ['hidden private input',declarations,p=>{p.claims['STORY:REQ-001'].expectedPaths.push('frontend/singularity/work-items/story/inputs/private.js');}],
  ['global private source',declarations,p=>{p.claims['STORY:REQ-001'].expectedPaths.push('singularity/work-items/story/inputs/private.js');}],
  ['unqualified executable test',declarations,p=>{p.claims['STORY:REQ-001'].tests.push('test/unqualified.test.js');}],
  ['unused root',declarations+'| unused | `third` |\n']
])test('planning rejects '+name+' before any source can be opened',()=>{
  const p=structuredClone(planned);change?.(p);assert.throws(()=>deriveRepositoryPlan(markdown,p),{code:'SPEC_REPOSITORY_PLAN_INVALID'});
});
test('code-step allocation cannot drop a required repository or spread scope into an unknown one',()=>{
  const p=deriveRepositoryPlan(declarations,planned);assertRepositoryPlanSources(p,'client-code',['app','service']);
  assert.throws(()=>assertRepositoryPlanSources(p,'server-code',['app']),error=>error.code==='SPEC_REPOSITORY_BINDING_REQUIRED'
    &&error.details.missing.includes('service')&&error.details.operation==='source.bind');
  assert.throws(()=>assertRepositoryPlanSources(p,'client-code',['app','service','unreviewed']),error=>error.details.unknown.includes('unreviewed'));
  assert.throws(()=>repositoryPlanProjection(p,'unreviewed'),{code:'SPEC_REPOSITORY_BINDING_REQUIRED'});
});
test('stored projection shapes cannot add readiness, corrupt paths or move into future schema versions',()=>{
  const p=deriveRepositoryPlan(declarations,planned);assert.equal(repositoryPlanValue(p),p);
  for(const mutate of [p=>{p.ready=true;},p=>{p.repositories[0].claims['STORY:REQ-001'].approved=true;},p=>{p.roots[0].repositoryId='unknown';},
    p=>{p.repositories[0].claims['STORY:REQ-001'].steps=true;},p=>{p.repositories[0].claims['STORY:REQ-001'].expectedPaths=['../escaped.js'];}]){
    const value=structuredClone(p);mutate(value);assert.throws(()=>repositoryPlanValue(value),{code:'SPEC_REPOSITORY_PLAN_INVALID'});
  }
  assert.throws(()=>repositoryPlanValue({...p,schemaVersion:2}),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});
test('supporting-file-only repositories remain part of code scope and global evidence remains global',()=>{
  const input=structuredClone(planned);delete input.claims['STORY:REQ-002'];
  input.claims['STORY:REQ-001']=claim(['frontend/src/app.js'],['frontend/test/app.test.js']);
  const p=deriveRepositoryPlan(declarations,input);
  assert.deepEqual(p.repositories[1].claims,{});assert.deepEqual(p.repositories[1].supportingFiles,['package.json']);
  assert.throws(()=>assertRepositoryPlanSources(p,'code',['app']),error=>error.code==='SPEC_REPOSITORY_BINDING_REQUIRED'&&error.details.missing.includes('service'));
  assert.equal(repositoryPlanTestLocation(p,'singularity/work-items/story/evidence/screen.png'),null);
  const single=deriveRepositoryPlan('## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `.` |',{
    ...input,claims:{'STORY:REQ-001':claim(['src/app.js'],['test/app.test.js']),'STORY:AC-001':input.claims['STORY:AC-001']},supportingFiles:[],supportingFileDetails:[]});
  assert.equal(single.repositories[0].claims['STORY:AC-001'],undefined);
});
test('a logical root cannot erase the private namespace of a globally protected path',()=>{
  for(const [prefix,local]of [['.sflow','results/current.js'],['singularity/work-items/story','inputs/current.js']]){
    const markdown='## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `'+prefix+'` |',
      input={...planned,claims:{'STORY:REQ-001':claim([prefix+'/'+local],[])},supportingFiles:[],supportingFileDetails:[]};
    assert.throws(()=>deriveRepositoryPlan(markdown,input),{code:'SPEC_REPOSITORY_PLAN_INVALID'});
  }
});
