/** Full source/test/consumer journey from the installed SDK; no source-checkout imports. */
import assert from 'node:assert/strict';import path from 'node:path';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {createFilesystemNamespaceStore} from '@sdk-name@/storage/filesystem';
import {createSqliteContentStore} from '@sdk-name@/storage/sqlite-content';
const guard=registerHooks({resolve(specifier,context,next){
  if(/\/(?:git|cli|state)\.mjs$/u.test(specifier))throw Error('Unexpected native authority: '+specifier);return next(specifier,context);
}});
const {createNamespaceEngine}=await import('@sdk-name@/hosts/namespace-engine');
const fresh=process.argv[2]==='fresh',scope={projectId:'installed-code-inputs'},workId='converter',authority={id:'application-authority',epoch:1},shared={kind:'shared'},
  records=await createFilesystemNamespaceStore({root:path.resolve('code-inputs-records'),binding:shared,create:fresh}),
  database=new DatabaseSync('code-inputs-content.db'),content=createSqliteContentStore({database,binding:shared,create:fresh});
let localRecords,localDatabase,principalId='author',agentId='analyst',person={name:'Author',email:'author@example.test'},starts=0;
const started=performance.now(),progress=label=>process.stderr.write(label+': '+Math.round(performance.now()-started)+' ms\n');
const access={current(){if(!fresh)throw Error('Accepted replay cannot authorize a new operation.');return {projectId:scope.projectId,principalId,
  actorKind:'human',identity:person,agentId,permissions:['project.enroll','configuration.approve','story.create','source.bind','source.baseline.retain',
    'phase.enter','phase.context.read','phase.prepare','phase.draft.read','phase.draft.write','phase.source.retain','phase.checks.run','phase.publish','phase.submit','phase.approve']};}},
  clock={now(){if(!fresh)throw Error('Accepted replay cannot restamp a record.');return '2026-11-10T05:00:00.000Z';}},common={records,content,scope,workId,authority,access,clock},
  json=async ref=>JSON.parse(Buffer.from((await content.read(scope,ref)).data)),publish=phaseId=>({phaseId,authored:'governed-agent',channel:'copilot-host'}),
  sourceFile='// @clause:CONVERTER:REQ-001 Convert an integer into hexadecimal.\n// @clause:CONVERTER:AC-001 Return FF for 255.\nexport const convert=value=>value.toString(16).toUpperCase();\n',
  testFile="import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:CONVERTER:AC-001\ntest('converts the approved value',()=>assert.equal(convert(255),'FF'));\n";
try{
  let engine,expected;
  if(fresh){
    const local={kind:'machine-local',deviceId:'installed-code-input-device'};
    localRecords=await createFilesystemNamespaceStore({root:path.resolve('code-inputs-local-records'),binding:local,create:true});
    localDatabase=new DatabaseSync('code-inputs-local-content.db');const localContent=createSqliteContentStore({database:localDatabase,binding:local,create:true});
    engine=createNamespaceEngine({...common,working:{records:localRecords,content:localContent}});
    await engine.run('project.enroll',{operationId:'enroll'});
    const body=(await content.put(scope,'config',Buffer.from('# Draft\n\nDescribe the approved observable behavior.\n'))).reference,
      approval={authorities:['reviewers'],minimum:1,allowSelfApproval:false},base={defaultTemplate:'phase.md',clarification:{mode:'off',markers:{mode:'off'}},specificationQuality:{mode:'off'},approval},
      packet={schemaVersion:1,format:'sflow-namespace-configuration-source/v1',definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',
        spec:{mode:'enforce',namespace:'CONVERTER',coverage:'enforce',acceptance:'presence'},codeDelivery:{traceability:{sourceBindings:'enforce'}},
        approvalAuthorities:{reviewers:{members:[{email:'reviewer@example.test'}]}},phases:{
          intake:{...base,label:'Intake',artifact:{path:'artifacts/intake/spec.md',kind:'requirements'}},
          design:{...base,label:'Plan',artifact:{path:'artifacts/design/plan.md',kind:'implementation-plan'},inputs:[{phase:'intake'}]},
          build:{...base,label:'Code',artifact:{path:'artifacts/build/summary.md',kind:'implementation-summary'},inputs:[{phase:'design'}],
            generation:{producer:'governed-agent',task:'code'},writeScope:'source-and-artifact',qualityCommands:[{id:'node-tests',kind:'test',modelPolicy:'never',ecosystem:'node',affectedRoots:['.'],
              argv:['node','--test','test/converter.test.js'],result:{adapter:'node-tap',path:'results/tests.tap'}}]},
          validate:{...base,label:'Validate',artifact:{path:'artifacts/validate/evidence.md',kind:'test-evidence'},writeScope:'artifact-only',inputs:[{phase:'build'}],testEvidenceFrom:'build'}},
        workTypes:{delivery:{label:'Converter',phases:['intake','design','build','validate'],plannedClaims:{mode:'required',clausePhases:['intake'],owners:{build:'design'}}}}},
        agents:[{id:'analyst',label:'Analyst',phases:['intake','design','build'],defaultFor:['intake','design','build'],mode:'read-write',body,skills:[],instructions:[]},
          {id:'verifier',label:'Verifier',phases:['validate'],defaultFor:['validate'],mode:'read-write',body,skills:[],instructions:[]}],skills:[],instructions:[],templates:[{path:'singularity/templates/phase.md',body}],files:[]},
      configuration=(await content.put(scope,'config',Buffer.from(JSON.stringify(packet)))).reference;
    await engine.run('configuration.approve',{operationId:'approve-config',source:configuration,expectedRevision:null,confirm:configuration.sha256,reason:'Reviewed all workflow dependencies.'});
    const story=(await content.put(scope,'state',Buffer.from('Convert integers into hexadecimal and retain the approved example test.'))).reference;
    await engine.run('story.create',{operationId:'create',workId,title:'Converter',workTypeId:'delivery',configurationId:'approve-config',source:story});
    async function write(phaseId,text){await engine.run('phase.prepare',{phaseId});const draft=await engine.run('phase.draft.read',{phaseId});
      await engine.run('phase.draft.write',{operationId:'write-'+phaseId,workId,phaseId,expectedRevision:draft.manifest.draft.revision,
        content:(await localContent.put(scope,'local',Buffer.from(text))).reference,reason:'Complete the exact current generation.'});}
    async function approve(phaseId){await engine.run('phase.submit',{phaseId});const {manifest}=await engine.run('phase.review',{phaseId}),binding=manifest.reviewBinding;
      const original={principalId,person,agentId};principalId='independent-reviewer';person={name:'Reviewer',email:'reviewer@example.test'};agentId=null;
      try{const vote=await engine.run('phase.approve',{phaseId,confirmation:{workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
        assert.equal(vote.approval.selfApproval,false);return vote;}finally{({principalId,person,agentId}=original);}}
    await write('intake','# Specification\n\n[CONVERTER:REQ-001] Convert an integer into hexadecimal.\n\n[CONVERTER:AC-001] Given 255, conversion returns FF.\n');
    await engine.run('phase.publish',publish('intake'));await approve('intake');progress('specification approved');
    await write('design','# Plan\n\n## Agent brief\n\nImplement the approved converter and regression.\n\n| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n'
      +'| CONVERTER:REQ-001 | `src/converter.js` | `test/converter.test.js` |\n| CONVERTER:AC-001 | `src/converter.js` | `test/converter.test.js` |\n');
    await engine.run('phase.publish',publish('design'));const planned=await approve('design');progress('plan approved');
    const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('@sdk-name@/sources/filesystem'),
      {createNodeCheckExecutionUnit}=await import('@sdk-name@/testing/execution'),{createNodeExecutionOwner}=await import('@sdk-name@/execution/runtime'),
      root=path.resolve('code-inputs-source');await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'test'));
    await writeFile(path.join(root,'src/converter.js'),'export const convert=value=>String(value);\n');await writeFile(path.join(root,'test/converter.test.js'),'// Original tests.\n');
    const source=await createFilesystemSourceUnit({root,id:'installed-converter-source',projectId:scope.projectId,repositoryId:'app'}),
      sourceReader=await createFilesystemSourceContentReader({root,id:'installed-converter-bytes',source:source.descriptor}),
      executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
      environment={NODE_OPTIONS:'--test-reporter='+import.meta.resolve('@sdk-name@/testing/node-test-reporter'),SINGULARITY_FLOW_NODE_TEST_ROOT:root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
      raw=await createNodeCheckExecutionUnit({id:'installed-converter-check',root,projectId:scope.projectId,repositoryId:'app',content,
        command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:value=>value.manifestSha256}),
      checks={owner:createNodeExecutionOwner({hostId:'installed-code-host'}),bindings:[{phaseId:'build',commandId:'node-tests',repositoryId:'app',executable:'node',executableSha256,environment,
        unit:{...raw,start(task){starts++;return raw.start(task);}}}]};
    engine=createNamespaceEngine({...common,working:{records:localRecords,content:localContent},sources:[source],sourceReaders:[sourceReader],checks});
    await engine.run('source.bind',{operationId:'select-source',workId,expectedRevision:planned.revision,repositories:['app'],reason:'Select the independently planned repository.'});
    await engine.run('source.baseline.retain',{operationId:'original-source',workId,sourceBindingId:'select-source'});
    await write('build','# Implementation\n\n## Agent brief\n\nThe converter and its exact pinned regression implement the approved example.\n');
    await writeFile(path.join(root,'src/converter.js'),sourceFile);await writeFile(path.join(root,'test/converter.test.js'),testFile);
    await engine.run('phase.source.retain',{operationId:'current-source',workId,phaseId:'build'});
    assert.equal((await engine.run('phase.checks.run',{operationId:'run-source-tests',workId,phaseId:'build'})).checks[0].tests.passed,1);
    progress('Code tests retained');await engine.run('phase.publish',publish('build'));await approve('build');assert.equal(starts,1);agentId='verifier';progress('Code approved');
    await write('validate','# Verification\n\n## Agent brief\n\nReview the exact approved Code and its original test execution; no additional test was run in this phase.\n');
    const entry=await engine.run('phase.enter',{phaseId:'validate',compose:true}),resource=entry.manifest.resources.find(row=>row.kind==='supporting-document');
    assert.ok(resource);assert.equal((await engine.run('phase.context.read',{workId,phaseId:'validate',contextSha256:entry.manifest.context.sha256,resourceId:resource.id})).content.kind,'text');
    await engine.run('phase.publish',publish('validate'));progress('verifier published');await approve('validate');assert.equal(starts,1);progress('verifier approved');
    const submitted=JSON.parse((await engine.run('document.read',{reference:{kind:'story-document',id:'REVIEW-validate-GEN-1',workId}})).document.content.text),
      publication=await json(submitted.publication.record),policy=publication.policyEvidence.find(row=>row.kind==='approved-code-inputs/v1'),manifest=await json(policy.record),report=await json(manifest.report);
    assert.equal(publication.checks,null);assert.equal(report.inputs[0].phase,'build');assert.equal(report.inputs[0].tests[0].tests.passed,1);
    expected={publication:submitted.publication,report};await writeFile('code-inputs-publication.json',JSON.stringify(expected));await rm(root,{recursive:true,force:true});
  }else{expected=JSON.parse(await readFile('code-inputs-publication.json','utf8'));engine=createNamespaceEngine(common);
    for(const phaseId of ['build','validate'])assert.equal((await engine.run('phase.publish',publish(phaseId))).status,'retained');}
  const {manifest}=await engine.run('phase.review.resources',{phaseId:'validate'}),document=manifest.resources.find(row=>row.kind==='code-inputs');assert.ok(document);
  const read=await engine.run('document.read',{reference:document.reference});assert.deepEqual(JSON.parse(read.document.content.text),expected.report);
  process.stdout.write(JSON.stringify(expected));
}finally{localRecords?.close?.();localDatabase?.close();records.close?.();database.close();guard.deregister();}
