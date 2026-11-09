/** Executed from an installed tarball in a separate, empty-PATH process. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createFilesystemNamespaceStore} from '@sdk-name@/storage/filesystem';
import {createSqliteContentStore} from '@sdk-name@/storage/sqlite-content';

const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='node:child_process'||/\/(?:git|cli|state)\.mjs$/u.test(specifier))throw Error('Unexpected installed Git or command owner: '+specifier);
  return next(specifier,context);
}});
const {createNamespaceEngine}=await import('@sdk-name@/hosts/namespace-engine');
const {NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE}=await import('@sdk-name@/hosts/namespace-publication');
const fresh=process.argv[2]==='fresh',scope={projectId:'installed-specification'},authority={id:'application-authority',epoch:1},workId='story-1';
const shared={kind:'shared'},local={kind:'machine-local',deviceId:'installed-specification-device'};
const records=await createFilesystemNamespaceStore({root:path.resolve('specification-records'),binding:shared,create:fresh});
const localRecords=await createFilesystemNamespaceStore({root:path.resolve('specification-private-records'),binding:local,create:fresh});
const database=new DatabaseSync(path.resolve('specification-content.db')),privateDatabase=new DatabaseSync(path.resolve('specification-private-content.db'));
const content=createSqliteContentStore({database,binding:shared,create:fresh}),localContent=createSqliteContentStore({database:privateDatabase,binding:local,create:fresh});
const access={current(){if(!fresh)throw Error('Retained publication cannot authorize a new effect.');
  return {projectId:scope.projectId,principalId:'application-author',actorKind:'human',agentId:'analyst',identity:{name:'Author',email:'author@example.test'},
    permissions:['project.enroll','configuration.approve','story.create','phase.prepare','phase.draft.read','phase.draft.write','phase.publish','phase.submit']};}};
const clock={now(){if(!fresh)throw Error('Retained specification cannot be restamped.');return '2026-11-08T18:00:00.000Z';}};
const options={records,content,working:{records:localRecords,content:localContent},scope,workId,authority,access,clock};
const engine=createNamespaceEngine(options),json=async ref=>JSON.parse(Buffer.from((await content.read(scope,ref)).data));
const spec='# Specification\n\n[STORY-1:REQ-001] Convert an integer into hexadecimal.\n\n[STORY-1:AC-001] Given 255, conversion returns FF.\n';
const plan='# Plan\n\nImplement the converter and boundary tests.\n\n| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n'
  +'| STORY-1:REQ-001 | `src/converter.js` | `test/converter.test.js` |\n| STORY-1:AC-001 | `src/converter.js` | `test/converter.test.js` |\n';
try {
  assert.equal(NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE,'sflow-specification-publication/v1');
  let expected=[];
  if(fresh) {
    await engine.run('project.enroll',{operationId:'enroll-specifications'});
    const body=(await content.put(scope,'config',Buffer.from('# Draft\n\nWrite the observable requirements and retain exact evidence.\n'))).reference;
    const approval={authorities:['reviewers'],minimum:1,allowSelfApproval:false};
    const base={defaultTemplate:'phase.md',clarification:{mode:'off',markers:{mode:'off'}},specificationQuality:{mode:'off'},approval};
    const source={schemaVersion:1,format:'sflow-namespace-configuration-source/v1',
      definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',
        approvalAuthorities:{reviewers:{members:[{email:'reviewer@example.test'}]}},
        spec:{mode:'enforce',namespace:'STORY-1',coverage:'enforce',acceptance:'presence'},
        phases:{intake:{...base,label:'Intake',artifact:{path:'artifacts/intake/spec.md',kind:'requirements'}},
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
      assert.equal(published.profile,NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE);
      if(phaseId==='intake')assert.equal((await json(evidence.index)).clauses.length,2);
      else {assert.deepEqual(Object.keys((await json(evidence.planned)).claims),['STORY-1:AC-001','STORY-1:REQ-001']);assert.equal(evidence.inputs[0].phase,'intake');}
      const {manifest}=await reviewer.run('phase.review',{phaseId}),binding=manifest.reviewBinding;
      const approved=await reviewer.run('phase.approve',{phaseId,confirmation:{workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
      assert.equal(approved.approval.selfApproval,false);expected.push({phase:phaseId,record:published.specifications.record});
    }
    await writeFile('specification-publications.json',JSON.stringify(expected));
  }else {
    expected=JSON.parse(await readFile('specification-publications.json','utf8'));
    for(const phaseId of ['intake','design'])assert.equal((await engine.run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'})).status,'retained');
  }
  process.stdout.write(JSON.stringify(expected));
}finally{database.close();privateDatabase.close();hook.deregister();}
