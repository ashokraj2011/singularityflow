import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestImpactPolicies,namespaceScriptTestInventory} from '../src/kernel/test-impact-selection.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {NAMESPACE_PHASE_POLICY_SCHEMAS} from '../src/foundation/record-schema.mjs';
import {isCodeInputEvidence,isConformanceEvidence} from '../src/engine-storage/namespace-policy-contract.mjs';
const rules=namespaceTestImpactPolicies(NODE_TEXT_DIGESTS),scripts=namespaceScriptTestInventory(NODE_TEXT_DIGESTS),sha='a'.repeat(64),other='b'.repeat(64),
  entry=(path,changed=false)=>({path,sha256:changed?other:sha,bytes:1,executable:false}),
  source=(repositoryId,entries)=>({repositoryId,revision:'sha256:'+sha,snapshot:{entries}}),
  fixture=()=>{
    const current=[source('shared',[entry('src/value.js',true)]),source('app',[entry('src/use.js'),entry('test/affected.js'),entry('test/stable.js')])],before=structuredClone(current);before[0].snapshot.entries[0].sha256=sha;
    const observation={schemaVersion:1,profile:'sflow-test-impact-observation/v1',analyzer:{id:'real-graph-port',version:'1',implementationSha256:'sha256:'+sha},
      sources:current.map(({repositoryId,revision})=>({repositoryId,revision})),nodes:[
        {repositoryId:'shared',path:'src/value.js',sha256:other,dependencies:[]},
        {repositoryId:'app',path:'src/use.js',sha256:sha,dependencies:[{repositoryId:'shared',path:'src/value.js'}]},
        {repositoryId:'app',path:'test/affected.js',sha256:sha,dependencies:[{repositoryId:'app',path:'src/use.js'}]},
        {repositoryId:'app',path:'test/stable.js',sha256:sha,dependencies:[]}],unknown:[]};
    return {current,before,observation,commands:[{repositoryId:'app',commandId:'suite',files:['test/affected.js','test/stable.js']}]};
  };
test('transitive cross-repository impact is cycle-safe and always retains explicitly planned tests',()=>{
  const f=fixture(),result=rules.select(f);assert.deepEqual(result.rows[0].files,['test/affected.js']);assert.equal(result.impactComplete,false);
  f.observation.nodes[0].dependencies.push({repositoryId:'app',path:'src/use.js'});
  assert.deepEqual(rules.select({...f,requiredFiles:[{repositoryId:'app',path:'test/stable.js'}]}).rows[0].files,['test/affected.js','test/stable.js']);
});
test('unknown, missing, deleted and protected graph inputs expand commands rather than fabricate a safe omission',()=>{
  for(const change of [f=>f.observation.nodes.pop(),f=>f.observation.unknown.push({repositoryId:'app',path:'src/use.js',reason:'dynamic-load'}),f=>f.before[1].snapshot.entries.push(entry('src/removed.js')),
    f=>{f.current[1].snapshot.entries[1].sha256=other;f.observation.nodes[2].sha256=other;}]){const f=fixture();change(f);const view=rules.select(f);assert.equal(view.dependencyCoverage,'expanded-configured-commands');assert.equal(view.rows[0].files.length,2);}
});
test('a graph cannot substitute source versions, unknown paths, duplicate members or foreign dependency edges',()=>{
  for(const change of [f=>f.observation.sources[0].revision='sha256:'+other,f=>f.observation.nodes.push(f.observation.nodes[0]),
    f=>f.observation.nodes[0].dependencies.push({repositoryId:'foreign',path:'src/other.js'}),f=>f.observation.nodes[0].path='../escape']){
    const f=fixture();change(f);assert.throws(()=>rules.select(f),error=>['ENGINE_PORT_RESULT_INVALID','TEST_IMPACT_SOURCE_CHANGED'].includes(error.code));}
});
test('impact packets cannot copy source bodies or invoke a getter during admission',()=>{
  for(const change of [f=>{f.observation.nodes[0].body='private source';},f=>{f.observation.sourceText='private source';},f=>{f.observation.unknown.push({repositoryId:'app',path:'src/use.js',reason:'private raw source text'});}]){
    const f=fixture();change(f);assert.throws(()=>rules.select(f),{code:'ENGINE_PORT_RESULT_INVALID'});}
  const f=fixture();let reads=0;Object.defineProperty(f.observation,'nodes',{enumerable:true,get(){reads++;return [];}});
  assert.throws(()=>rules.select(f),{code:'ENGINE_PORT_RESULT_INVALID'});assert.equal(reads,0);
});
test('script selection preserves the pinned runner and rejects argument/filter injection',()=>{
  const command={kind:'test',argv:['node','runner.mjs','--test-reporter=junit','--','test/a.js','test/b.js'],result:{adapter:'junit-xml',minimumDiscovered:2,minimumPassed:2}},
    declaration={adapter:'node-script-junit-v1',dependencyScope:'repository-and-node-builtins-only',tests:[{id:'a',path:'test/a.js',name:'a'},{id:'b',path:'test/b.js',name:'b'}]};
  assert.deepEqual(scripts.narrow(command,declaration,['test/a.js']).argv,['node','runner.mjs','--test-reporter=junit','--','test/a.js']);
  for(const argv of [['node','runner.mjs','--filter','test/a.js'],['node','../runner.mjs','--','test/a.js']])assert.throws(()=>scripts.narrow({...command,argv},declaration,['test/a.js']));
  assert.throws(()=>scripts.narrow(command,declaration,['test/a.js'],{requiredFiles:['test/b.js']}),{code:'SELECTIVE_TEST_REQUIRED_FILE_EXCLUDED'});
});
test('every readable Code input and conformance version dispatches, while future kinds remain unavailable',()=>{
  for(const [family,prefix,recognize]of [[NAMESPACE_PHASE_POLICY_SCHEMAS.codeInputs,'approved-code-inputs',isCodeInputEvidence],[NAMESPACE_PHASE_POLICY_SCHEMAS.conformance,'conformance',isConformanceEvidence]]){
    for(let version=family.minimumReadableVersion;version<=family.maximumReadableVersion;version++)assert.equal(recognize(prefix+'/v'+version),true);
    assert.equal(recognize(prefix+'/v'+(family.maximumReadableVersion+1)),false);assert.equal(recognize(prefix+'/v0'),false);assert.equal(recognize(prefix+'/v01'),false);
  }
});
