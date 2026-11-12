import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {artifactSetDiff,disclosureLines} from '../src/artifact-sets.mjs';
import {artifactSetPolicies} from '../src/kernel/configuration-path-policies.mjs';
import {namespaceArtifactSetPolicies} from '../src/kernel/namespace-artifact-sets.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {namespaceCodePolicyProfile,namespaceCodePreflightVersion,namespaceHumanDecisionProfile} from '../src/foundation/record-schema.mjs';
import {isCodePolicyEvidence} from '../src/engine-storage/namespace-policy-contract.mjs';
const golden=JSON.parse(await readFile(new URL('./fixtures/artifact-repair/native-diff-v1.json',import.meta.url),'utf8')),
  pure=artifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX),values=namespaceArtifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
for(const [index,row]of golden.cases.entries())test('captured native artifact difference '+index+' keeps its value and disclosure',()=>{
  const {previous,current,options}=row.input;assert.deepEqual(pure.artifactSetDiffValues(previous,current,options),row.result);
  assert.deepEqual(artifactSetDiff(previous,current,options),row.result);assert.deepEqual(disclosureLines(row.result),row.disclosure);
});
test('target members belong to the reopened declaration and repository aliases normalize without widening scope',()=>{
  const definition={workItemRoot:'work',artifactSets:{target:{primary:'main.md',members:[{path:'main.md',role:'requirements',required:true},{path:'proof/',role:'supporting-evidence'}]}}},
    workflow={workItem:{id:'item'}},phase={id:'custom-analysis',artifactSet:'target',requiredArtifact:{path:'artifacts/custom/main.md'}};
  assert.deepEqual(values.repairSelection(definition,workflow,phase,['work/item/artifacts/custom/proof/','proof/','main.md']).members,['main.md','proof/']);
  for(const members of [['source-phase.md'],['proof/undeclared.txt'],['../main.md'],['/absolute.md'],['proof//'],['']])
    assert.throws(()=>values.repairSelection(definition,workflow,phase,members));
});
test('file-bound comparison discloses incidental changes without counting a requested child twice through its collection',()=>{
  const definition={artifactSets:{packet:{primary:'main.md',members:[{path:'main.md',role:'requirements',required:true},
    {path:'proof/',role:'supporting-evidence'},{path:'proof/notes.txt',role:'test-report',required:true}]}}},
    workflow={workItem:{id:'w'}},phase={id:'custom',artifactSet:'packet',requiredArtifact:{path:'artifacts/custom/main.md'}},
    ref=char=>({namespace:'evidence',sha256:char.repeat(64),bytes:8}),catalog=files=>values.catalog(definition,workflow,phase,{primary:ref('a'),files}),
    previous=catalog([{path:'proof/notes.txt',content:ref('b')},{path:'proof/other.txt',content:ref('c')}]),
    current=catalog([{path:'proof/notes.txt',content:ref('d')},{path:'proof/other.txt',content:ref('c')}]),
    requested=values.repairComparison(previous,current,['proof/notes.txt']);
  assert.deepEqual(requested.incidental,[]);assert.equal(requested.files[0].requested,true);assert.deepEqual(requested.unchangedRequested,[]);
  const extra=catalog([{path:'proof/notes.txt',content:ref('d')}]),withRemoval=values.repairComparison(previous,extra,['proof/notes.txt']);
  assert.equal(withRemoval.files.find(row=>row.path==='proof/other.txt').after,null);assert.deepEqual(withRemoval.incidental.map(row=>row.path),['proof/']);
  assert.deepEqual(values.repairComparison(previous,current,['main.md']).unchangedRequested,['main.md']);
});
test('new document-only Code profiles keep repository coverage and visual authority explicit',()=>{
  assert.equal(namespaceHumanDecisionProfile({schemaVersion:4}).artifactRepair,true);
  for(const repositoryCoverage of [false,true])for(const humanAcceptance of [false,true]){
    const version=(repositoryCoverage?22:20)+(humanAcceptance?1:0),profile=namespaceCodePolicyProfile('code',{schemaVersion:version});
    assert.equal(profile.documentRepair,true);assert.equal(Boolean(profile.repositoryCoverage),repositoryCoverage);assert.equal(Boolean(profile.humanAcceptance),humanAcceptance);
    assert.equal(isCodePolicyEvidence(profile.kind),true);
    assert.equal(namespaceCodePreflightVersion({history:{profile:'sflow-namespace-code-history/v9'},...(repositoryCoverage?{repositoryScope:{profile:'sflow-namespace-repository-coverage/v1'}}:{})}),repositoryCoverage?22:20);
  }
  assert.equal(isCodePolicyEvidence('code-delivery/v28'),false);assert.equal(isCodePolicyEvidence('code-delivery/v020'),false);
});
