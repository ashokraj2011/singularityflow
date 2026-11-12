import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
const identitySource='// @clause:STORY-1:REQ-002 Preserves the independent backend identity operation.\n// @clause:STORY-1:AC-002 Returns the original backend value without conversion.\nexport const convert=value=>value;\n',
  identityTest="import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-002\ntest('preserves the backend value',()=>assert.equal(convert(7),7));\n",
  specification='# Specification\n\n## Requirements\n\n[STORY-1:REQ-001] Convert frontend integers to hexadecimal.\n[STORY-1:REQ-002] Preserve backend identity.\n\n## Acceptance criteria\n\n[STORY-1:AC-001] Given frontend 255, return FF.\n[STORY-1:AC-002] Given backend 7, return 7.\n',
  plan='# Delivery plan\n\n## Agent brief\n\nChange the frontend converter while preserving the separately owned backend identity.\n\n## Planned changes\n\n| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n'
    +['REQ-001','AC-001'].map(id=>'| STORY-1:'+id+' | `frontend/src/converter.js` | `frontend/test/converter.test.js` |\n').join('')
    +['REQ-002','AC-002'].map(id=>'| STORY-1:'+id+' | `backend/src/converter.js` | `backend/test/converter.test.js` |\n').join('')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service-1 | `backend` |\n',
  report=(verdict='matched')=>releaseReport(verdict)+'| STORY-1:REQ-002 | matched |\n| STORY-1:AC-002 | matched |\n';
for(const backend of ['sqlite','application','filesystem'])test(backend+': qualified targeted repair cannot edit an identical local path in a different repository',{timeout:600000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend,repositories:2,specification,plan,
    storyText:'Convert frontend integers to hexadecimal; preserve the backend identity operation. Frontend 255 must become FF and backend 7 must remain 7.',
    source:index=>index?identitySource:converterSource,testSource:index=>index?identityTest:actualWitnessTest,
    configure:source=>{source.definition.phases.build.repairBudget={maxAttempts:1,resetOnPhase:'intake'};
      source.definition.workTypes.simple.reworkLoops=[{from:'release',to:'build',maxAttempts:1,resetOnPhase:'intake'}];}}).catch(error=>{t.diagnostic(JSON.stringify(error.details));throw error;});
  const reviewer=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.review','phase.reject']})}});
  await f.write('release',report('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.engine.run('phase.submit',{phaseId:'release'});
  const {manifest}=await reviewer.run('phase.review',{phaseId:'release'}),input={phaseId:'release',target:'build',clauseIds:['STORY-1:REQ-001'],reason:'Repair only the reviewed frontend clause while preserving the independently planned backend.',confirm:manifest.reviewBinding.packetSha256};
  await reviewer.run('phase.reject',input);f.control.agentId='analyst';await f.write('build','# Qualified repair\n\n## Agent brief\n\nExecute both repositories while preserving the unselected backend.\n');
  const entry=await f.engine.run('phase.enter',{phaseId:'build'});assert.deepEqual(entry.manifest.repairScope.current.repositories.map(row=>({id:row.id,paths:row.paths})),[
    {id:'app',paths:['src/converter.js','test/converter.test.js']},{id:'service-1',paths:[]}]);
  const testFile=path.join(f.roots[0],'test/converter.test.js');await writeFile(testFile,(await readFile(testFile,'utf8'))+"\ntest('repairs the next frontend boundary',()=>assert.equal(convert(256),'100'));\n");
  await writeFile(path.join(f.roots[1],'src/converter.js'),identitySource+'// An edit outside the selected repository.\n');
  await f.engine.run('phase.source.retain',{operationId:'outside-repository-source',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('outside-repository-tests');
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),error=>error.code==='ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED'
    &&error.details.outside.some(row=>row.repositoryId==='service-1'&&row.path==='src/converter.js'));
  await writeFile(path.join(f.roots[1],'src/converter.js'),identitySource);await f.engine.run('phase.source.retain',{operationId:'correct-repository-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('correct-repository-tests');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');
  f.control.agentId='release-reviewer';await f.write('release',report());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),6);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});assert.equal((await reviewer.run('phase.reject',input)).changeRequest.targetPhase,'build');
});
