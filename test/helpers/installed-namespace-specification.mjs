/** Executed from an installed tarball in a separate, empty-PATH process. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createFilesystemNamespaceStore} from '@sdk-name@/storage/filesystem';
import {createSqliteContentStore} from '@sdk-name@/storage/sqlite-content';

const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='node:child_process'||/\/(?:git|cli|state)\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or command owner: '+specifier);
  return next(specifier,context);
}});
const {createNamespaceEngine}=await import('@sdk-name@/hosts/namespace-engine');
const {NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE,NAMESPACE_POLICY_PUBLICATION_PROFILE}=await import('@sdk-name@/hosts/namespace-publication');
const {STARTER_CHECKLIST}=await import('@sdk-name@/specifications/node');
const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('@sdk-name@/sources/filesystem');
const fresh=process.argv[2]==='fresh',qualified=process.argv[3]==='qualified',file=name=>path.resolve(qualified?'qualified-'+name:name),
  scope={projectId:'installed-specification'},authority={id:'application-authority',epoch:1},workId='story-1';
const shared={kind:'shared'},local={kind:'machine-local',deviceId:'installed-specification-device'};
const records=await createFilesystemNamespaceStore({root:file('specification-records'),binding:shared,create:fresh});
const localRecords=await createFilesystemNamespaceStore({root:file('specification-private-records'),binding:local,create:fresh});
const database=new DatabaseSync(file('specification-content.db')),privateDatabase=new DatabaseSync(file('specification-private-content.db'));
const content=createSqliteContentStore({database,binding:shared,create:fresh}),localContent=createSqliteContentStore({database:privateDatabase,binding:local,create:fresh});
const access={current(request){if(!fresh&&request.operation!=='phase.source.inspect')throw Error('Retained publication cannot authorize a new effect.');
  return {projectId:scope.projectId,principalId:'application-author',actorKind:'human',agentId:'analyst',identity:{name:'Author',email:'author@example.test'},
    permissions:fresh?['project.enroll','configuration.approve','story.create','phase.prepare','phase.draft.read','phase.draft.write','phase.publish','phase.submit',
      'source.bind','source.baseline.retain','phase.source.retain','phase.source.inspect']:['phase.source.inspect']};}};
const clock={now(){if(!fresh)throw Error('Retained specification cannot be restamped.');return '2026-11-08T18:00:00.000Z';}};
const options={records,content,working:{records:localRecords,content:localContent},scope,workId,authority,access,clock};
const engine=createNamespaceEngine(options),json=async ref=>JSON.parse(Buffer.from((await content.read(scope,ref)).data));
const spec='# Specification\n\n## Actors\n\nCalculator user.\n\n## User scenarios\n\nConvert a value.\n\n## Requirements\n\n[STORY-1:REQ-001] Convert an integer into hexadecimal.\n\n[STORY-1:AC-001] Given 255, conversion returns FF.\n';
const originalPlan='# Plan\n\nImplement the converter and boundary tests.\n\n| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n'
  +'| STORY-1:REQ-001 | `src/converter.js` | `test/converter.test.js` |\n| STORY-1:AC-001 | `src/converter.js` | `test/converter.test.js` |\n';
const plan=qualified?originalPlan.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
  .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
  +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | `frontend` |\n| service | `backend` |\n':originalPlan;
try {
  assert.equal(NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE,'sflow-specification-publication/v1');
  let expected=[],revision=null;
  if(fresh) {
    await engine.run('project.enroll',{operationId:'enroll-specifications'});
    const body=(await content.put(scope,'config',Buffer.from('# Draft\n\nWrite the observable requirements and retain exact evidence.\n'))).reference;
    const approval={authorities:['reviewers'],minimum:1,allowSelfApproval:false};
    const base={defaultTemplate:'phase.md',clarification:{mode:'off',markers:{mode:'off'}},specificationQuality:{mode:'off'},approval};
    const source={schemaVersion:1,format:'sflow-namespace-configuration-source/v1',
      definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',codeDelivery:{traceability:{sourceBindings:'enforce'}},
        approvalAuthorities:{reviewers:{members:[{email:'reviewer@example.test'}]}},
        spec:{mode:'enforce',namespace:'STORY-1',coverage:'enforce',acceptance:'presence'},
        phases:{intake:{...base,label:'Intake',artifact:{path:'artifacts/intake/spec.md',kind:'requirements'},specificationQuality:{mode:'enforce'}},
          design:{...base,label:'Design',artifact:{path:'artifacts/design/plan.md',kind:'implementation-plan'},inputs:[{phase:'intake'}]},
          build:{...base,label:'Build',artifact:{path:'artifacts/build/summary.md',kind:'implementation-summary'},inputs:[{phase:'design'}],
            generation:{producer:'governed-agent',task:'code'},writeScope:'source-and-artifact'}},
        workTypes:{delivery:{label:'Delivery',phases:['intake','design','build'],plannedClaims:{mode:'required',clausePhases:['intake'],owners:{build:'design'}}}}},
      agents:[{id:'analyst',label:'Analyst',phases:['intake','design','build'],defaultFor:['intake','design','build'],mode:'read-write',body,skills:[],instructions:[]}],
      skills:[],instructions:[],templates:[{path:'singularity/templates/phase.md',body}],files:[]};
    const reference=(await content.put(scope,'config',Buffer.from(JSON.stringify(source)))).reference;
    await engine.run('configuration.approve',{operationId:'approve-specification-configuration',source:reference,expectedRevision:null,confirm:reference.sha256,reason:'Reviewed the workflow and all policy dependencies.'});
    const storySource=(await content.put(scope,'state',Buffer.from('# Story\nConvert 255 to FF and retain tests.\n'))).reference;
    await engine.run('story.create',{operationId:'create-specification-story',workId,title:'Converter',workTypeId:'delivery',configurationId:'approve-specification-configuration',source:storySource});
    const reviewer=createNamespaceEngine({...options,access:{current:()=>({projectId:scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
      identity:{name:'Reviewer',email:'reviewer@example.test'},permissions:['phase.approve']})}});
    for(const [phaseId,text]of [['intake',spec],['design',plan]]) {
      await engine.run('phase.prepare',{phaseId});const draft=await engine.run('phase.draft.read',{phaseId});
      const edited=(await localContent.put(scope,'local',Buffer.from(text))).reference;
      await engine.run('phase.draft.write',{operationId:'author-'+phaseId,workId,phaseId,expectedRevision:draft.manifest.draft.revision,content:edited,reason:'Retain the complete authored contract.'});
      await engine.run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'});
      await engine.run('phase.submit',{phaseId});
      const packet=JSON.parse((await engine.run('document.read',{reference:{kind:'story-document',id:'REVIEW-'+phaseId+'-GEN-1',workId}})).document.content.text),
        published=await json(packet.publication.record),evidence=await json(published.specifications.record);
      assert.equal(published.profile,phaseId==='intake'?NAMESPACE_POLICY_PUBLICATION_PROFILE:NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE);
      if(phaseId==='intake') {
        assert.equal((await json(evidence.index)).clauses.length,2);
        const analysis=await json(published.policyEvidence[0].record),report=await json(analysis.report);
        assert.equal(report.findings.length,0);assert.equal(report.binding.artifactSha256,published.artifact.content.sha256);
      }
      else {assert.deepEqual(Object.keys((await json(evidence.planned)).claims),['STORY-1:AC-001','STORY-1:REQ-001']);assert.equal(evidence.inputs[0].phase,'intake');
        assert.equal(evidence.schemaVersion,qualified?2:1);
        if(qualified){const repositories=await json(evidence.repositoryPlan);assert.equal(repositories.format,'sflow-repository-plan/v1');
          assert.deepEqual(repositories.repositories.map(row=>row.id),['app','service']);}}
      const {manifest}=await reviewer.run('phase.review',{phaseId}),binding=manifest.reviewBinding;
      const approvalInput={phaseId,confirmation:{workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}};
      if(phaseId==='intake')await assert.rejects(reviewer.run('phase.approve',approvalInput),{code:'APPROVAL_CHECKLIST_INCOMPLETE'});
      const approved=await reviewer.run('phase.approve',{...approvalInput,...(phaseId==='intake'?{checklist:STARTER_CHECKLIST.articles.map(article=>({article:article.id,decision:'satisfied'}))}:{})});
      assert.equal(approved.approval.selfApproval,false);revision=approved.revision;expected.push({phase:phaseId,record:published.specifications.record});
    }
  }else {
    expected=JSON.parse(await readFile(file('specification-publications.json'),'utf8'));
    for(const phaseId of ['intake','design'])assert.equal((await engine.run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'})).status,'retained');
  }
  // A different physical checkout observes the same accepted plan/source proof on reopen.
  const current='// @clause:STORY-1:REQ-001 Converts the approved input into hexadecimal.\n// @clause:STORY-1:AC-001 Returns FF for the approved example.\nexport const convert=value=>value.toString(16).toUpperCase();\n';
  const sources=[],sourceReaders=[],roots=[],repositories=qualified?['app','service']:['app'];
  for(const id of repositories){const root=file((fresh?'specification-source-one':'specification-source-two')+(qualified?'-'+id:''));roots.push(root);
    await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'test'),{recursive:true});
    await writeFile(path.join(root,'src/converter.js'),fresh?'export const convert=value=>String(value);\n':current);
    await writeFile(path.join(root,'test/converter.test.js'),'// An authored test is not retained execution evidence.\n');
    const unit=await createFilesystemSourceUnit({root,id:'installed-specification-source'+(qualified?'-'+id:''),projectId:scope.projectId,repositoryId:id});sources.push(unit);
    sourceReaders.push(await createFilesystemSourceContentReader({root,id:'installed-specification-bytes'+(qualified?'-'+id:''),source:unit.descriptor}));}
  const code=createNamespaceEngine({...options,sources,sourceReaders});
  if(fresh) {
    await code.run('source.bind',{operationId:'installed-specification-source-selection',workId,expectedRevision:revision,repositories,reason:'Select the independently planned source.'});
    await code.run('source.baseline.retain',{operationId:'installed-specification-original',workId,sourceBindingId:'installed-specification-source-selection'});
    await code.run('phase.prepare',{phaseId:'build'});for(const root of roots)await writeFile(path.join(root,'src/converter.js'),current);
    await code.run('phase.source.retain',{operationId:'installed-specification-current',workId,phaseId:'build'});
  }
  const delivery=(await code.run('phase.delivery.inspect',{phaseId:'build'})).manifest;
  assert.equal(delivery.schemaVersion,qualified?4:3);assert.equal(delivery.clauses.status,'observed');
  assert.equal(delivery.clauses.repositories.length,repositories.length);
  for(const row of delivery.clauses.repositories)assert.deepEqual(row.totals,{required:2,bindings:2,missing:0});
  if(qualified){assert.equal(delivery.clauses.profile,'sflow-planned-source-clause-observations/v2');assert.ok(delivery.clauses.plan.repositoryPlan);}
  assert.equal(delivery.applicationAcceptanceEstablished,false);assert.ok(delivery.requiredPolicyOwners.includes('code-delivery'));
  const implementation=(await code.run('phase.delivery.inspect',{phaseId:'build',includeImplementation:true})).manifest;
  assert.equal(implementation.schemaVersion,5);assert.equal(implementation.implementation.status,'observed');
  assert.equal(implementation.implementation.totals.bindings,2*repositories.length);assert.equal(implementation.implementation.totals.problems,0);
  assert.deepEqual(implementation.implementation.repositories.map(row=>row.id),repositories);
  assert.equal(implementation.applicationAcceptanceEstablished,false);assert.ok(implementation.requiredPolicyOwners.includes('code-delivery'));
  if(fresh) {
    await assert.rejects(code.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'}),error=>
      error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('code-delivery'));
    expected.push({phase:'build',clauses:delivery.clauses,implementation:implementation.implementation});await writeFile(file('specification-publications.json'),JSON.stringify(expected));
  }else {assert.deepEqual(delivery.clauses,expected.at(-1).clauses);assert.deepEqual(implementation.implementation,expected.at(-1).implementation);}
  for(const root of roots)await rm(root,{recursive:true,force:true});
  process.stdout.write(JSON.stringify(expected));
}finally{database.close();privateDatabase.close();hook.deregister();}
