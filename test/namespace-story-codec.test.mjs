import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createNamespaceStoryCodec,namespaceStoryReadKey,namespaceStoryGenesisKey} from '../src/engine-storage/namespace-story-codec.mjs';
import {assertStoryPolicy} from '../src/kernel/story-policy.mjs';
const original=JSON.parse(await readFile(new URL('./fixtures/namespace-story-packets/native-v1.json',import.meta.url),'utf8'));
const workflow=()=>structuredClone(original.body.workflow);

test('actual pre-extraction Story intents, transactions, records and receipts retain their v1 identities',()=>{
  assert.equal(original.baseline,'9d486f4d3');
  const codec=createNamespaceStoryCodec(original),plan=original.intent.value;
  const inputs=Object.fromEntries(['operationId','workId','title','workTypeId','configurationId','source'].map(key=>[key,plan[key]]));
  assert.equal(codec.parameters(inputs,{recordId:original.recordsId,contentId:original.contentId}),plan.parametersSha256);
  assert.equal(namespaceStoryReadKey(original.workId),original.readHead.key);
  assert.equal(namespaceStoryGenesisKey(original.workId),original.genesis.key);
  assert.deepEqual(codec.firstHead(plan),original.head.value);
  assert.deepEqual(codec.projected('genesis',plan),original.genesis.value);
  assert.deepEqual(codec.projected('manifest',plan),original.manifest.value);
  assert.equal(codec.txDigest(codec.transaction(plan)),plan.requestDigest);
  assert.equal(plan.requestDigest,'344ac83307b00b477cafb422694774c2f3b45fb4d3e227f1e6ef10932f2c371b');
  assert.deepEqual(codec.receipt(original.prepared,codec.transaction(plan,true)),original.prepared.receipt);
  assert.deepEqual(codec.receipt(original.committed,codec.transaction(plan)),original.committed.receipt);
  assert.equal(createHash('sha256').update(JSON.stringify(original.body)+'\n').digest('hex'),plan.state.sha256);
});

for(const [label,change] of [
  ['reviewer membership',w=>w.resolution.approvalAuthorities.reviewers.members.push({email:'intruder@example.test'})],
  ['approval quorum',w=>w.phases.intake.approvalPolicy.minimum=0],
  ['self-approval',w=>w.phases.intake.approvalPolicy.allowSelfApproval=!w.phases.intake.approvalPolicy.allowSelfApproval],
  ['approval mode',w=>w.phases.intake.approvalPolicy.mode='none'],
  ['author identity',w=>w.phases.intake.defaultAgent=null],
  ['source edit authority',w=>w.phases.intake.writeScope='source-and-artifact'],
  ['artifact location',w=>w.phases.intake.requiredArtifact.path='another-report.md'],
  ['test checks',w=>w.phases.intake.qualityCommands=['echo skip']],
  ['input provenance',w=>w.phases.intake.inputs=['invented-upstream']],
  ['generation producer',w=>w.phases.intake.generationPolicy.producer='deterministic'],
  ['routing rules',w=>w.resolution.decisions=[]],
  ['workflow selection',w=>w.workItem.workType='another-workflow'],
  ['configuration selection',w=>w.resolution.configurationApprovalId='another-approval'],
  ['phase order',w=>w.phaseOrder.unshift('unapproved-phase')],
  ['phase membership',w=>w.phases.unapproved={...w.phases.intake,id:'unapproved'}],
  ['original creator',w=>w.workItem.createdBy.principalId='another-person']
])test('v1 policy proof refuses altered '+label,()=>{
  const pinned=workflow(),changed=structuredClone(pinned);change(changed);
  assert.throws(()=>assertStoryPolicy(changed,pinned),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.details.profile==='sflow-namespace-story-policy/v1');
});

test('policy projection permits actual lifecycle progress and preserves the original creator enrollment',()=>{
  const pinned=workflow(),changed=structuredClone(pinned);
  changed.currentPhase=null;changed.status='closed';changed.phases.intake.generation=3;changed.phases.intake.status='approved';
  changed.phases.intake.approvals.push({by:'reviewer'});changed.history.push({event:'phase_approved'});
  changed.workItem.title='A clearer display title';changed.workItem.workTypeLabel='Translated label';
  changed.execution={status:'bound',repositories:[{id:'application'}]};
  assert.doesNotThrow(()=>assertStoryPolicy(changed,pinned));
  const future=structuredClone(pinned);future.schemaVersion=99;
  assert.throws(()=>assertStoryPolicy(future,pinned),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
});
