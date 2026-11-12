import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
test('an earlier document member return does not impose its scope on downstream planning, Code or release',{timeout:240000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend:'sqlite',configure(source){const primary=source.definition.phases.intake.artifact.path.split('/').at(-1);
    source.definition.artifactSets={scopePacket:{primary,members:[{path:primary,role:'requirements',required:true}]}};source.definition.phases.intake.artifactSet='scopePacket';
    source.definition.phases.release.approval.rejectTo=['intake','build','release'];}});
  await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.engine.run('phase.submit',{phaseId:'release'});
  const reviewer=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.review','phase.reject']})}}),
    view=await reviewer.run('phase.review',{phaseId:'release'}),primary=(await f.capture()).workflow.phases.intake.requiredArtifact.path.split('/').at(-1),
    request={phaseId:'release',target:'intake',members:[primary],
      reason:'Clarify the original requirement document while retaining the approved observable converter intent.',confirm:view.manifest.reviewBinding.packetSha256};
  await reviewer.run('phase.reject',request);f.control.agentId='analyst';
  await f.write('intake',specificationText+'\nThe approved example remains the same observable outcome.\n');
  await f.engine.run('phase.publish',{phaseId:'intake',...releasePublish});await f.approve('intake');
  await f.write('design',planText);await f.engine.run('phase.publish',{phaseId:'design',...releasePublish});await f.approve('design');
  await f.write('build','# Revalidated converter\n\n## Agent brief\n\nRevalidate against the independently approved successor documents and execute the boundary regressions.\n');
  const source=path.join(f.root,'test/converter.test.js');await writeFile(source,(await readFile(source,'utf8'))+"\ntest('converts the next integer',()=>assert.equal(convert(256),'100'));\n");
  await f.engine.run('phase.source.retain',{operationId:'downstream-document-return-source',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.checks.run',{operationId:'downstream-document-return-tests',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');
  f.control.agentId='release-reviewer';await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),2);
});
