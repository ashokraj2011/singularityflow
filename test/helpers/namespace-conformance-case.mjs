import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePhaseCheckReader} from '../../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespacePublicationReader} from '../../src/engine-storage/namespace-publication-reader.mjs';
import {canonicalJson} from '../../src/foundation/record-schema.mjs';

export async function namespaceConformanceCase(t,backend){
  const f=await namespaceReleaseFixture(t,{backend}),input={phaseId:'release',...releasePublish},starts=f.starts();
  await f.write('release',releaseReport()+'\n## Upstream discrepancies\n\nSTORY-1:REQ-001 remains partial.\n');const before=await f.head();
  await assert.rejects(f.engine.run('phase.publish',input),error=>error.code==='ARTIFACT_AUTHORING_INCOMPLETE'&&error.details.findings.some(row=>row.code==='conformance.verdict-contradicted'));
  assert.deepEqual(await f.head(),before);await f.write('release',releaseReport());
  assert.equal((await f.engine.run('phase.publish',input)).status,'published');const p=await f.published('release');
  assert.ok(p.report.rows.find(row=>row.clauseId==='STORY-1:AC-001').evidence.every(row=>row.witnesses.every(witness=>typeof witness.id==='string'&&witness.id.length>0)));
  assert.equal(p.report.format,'sflow-namespace-conformance-policy-report/v1');assert.equal(p.report.rows.length,2);assert.deepEqual(p.report.gaps,[]);
  assert.equal(p.report.inputs.inputs[0].phase,'build');assert.equal(p.report.inputs.inputs[0].tests[0].tests.passed,1);assert.equal(p.value.checks,null);assert.equal(f.starts(),starts);
  assert.equal((await f.approve('release')).approval.selfApproval,false);assert.equal((await f.capture()).workflow.status,'closed');
  const {manifest}=await f.engine.run('phase.review.resources',{phaseId:'release'}),resource=manifest.resources.find(row=>row.kind==='conformance');
  assert.ok(resource);assert.deepEqual(JSON.parse((await f.engine.run('document.read',{reference:resource.reference})).document.content.text),p.report);
  const observer=createNamespaceStoryObserver(f.common),checks=createNamespacePhaseCheckReader({...f.common,observer}),reader=createNamespacePublicationReader({observer,checks,scope:f.scope,workId:f.inputs.workId}),
    save=async value=>(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference,changed=structuredClone(p.report);changed.rows[0].evidence[0].verdict='missing';
  for(const [report,code]of [[changed,'ENGINE_STORAGE_CORRUPT'],[{...p.report,schemaVersion:2},'ENGINE_STORAGE_UNSUPPORTED']]){
    const manifest={...p.manifest,report:await save(report)},value={...p.value,policyEvidence:[{...p.policy,record:await save(manifest)}]};
    await assert.rejects(reader.read({...p.binding,record:await save(value)},'release'),{code});
  }
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  assert.deepEqual(await reader.accepted(p.binding,'release'),p.value);
  assert.equal((await createNamespaceEngine({...f.common,clock:{now(){throw Error('Do not restamp accepted release.');}}}).run('phase.publish',input)).status,'retained');
  assert.equal(f.starts(),starts);
}
