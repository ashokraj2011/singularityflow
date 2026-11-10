/** Durable installed SDK phases; each process can resume from shared receipts and local working ports. */
import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {registerHooks} from 'node:module';
import {createFilesystemNamespaceStore} from '@sdk-name@/storage/filesystem';
import {createSqliteContentStore} from '@sdk-name@/storage/sqlite-content';
const guard=registerHooks({resolve(specifier,context,next){if(/\/(?:git|cli|state)\.mjs$/u.test(specifier))throw Error('Unexpected native authority: '+specifier);return next(specifier,context);}});
const {createNamespaceEngine}=await import('@sdk-name@/hosts/namespace-engine'),stage=process.argv[2],profile=process.argv[3],rework=profile==='rework',humanReturn=profile==='human-return',partial=profile==='partial-decisions',repair=rework||humanReturn,fresh=stage==='setup',mutating=!stage.startsWith('replay'),
  scope={projectId:'installed-code-inputs'},workId='converter',authority={id:'application-authority',epoch:1},shared={kind:'shared'},
  records=await createFilesystemNamespaceStore({root:path.resolve('records'),binding:shared,create:fresh}),database=new DatabaseSync('content.db'),
  content=createSqliteContentStore({database,binding:shared,create:fresh}),root=path.resolve('source');
let localRecords,localDatabase,principalId='author',agentId=['review','finish','draft-partial','return','publish-final','submit-final','approve-final'].includes(stage)?'verifier':'analyst',person={name:'Author',email:'author@example.test'},starts=0,edits=0;
const begun=performance.now(),progress=label=>process.stderr.write(stage+' '+label+': '+Math.round(performance.now()-begun)+' ms\n'),
  access={current(){if(!mutating&&!humanReturn&&!partial)throw Error('Replay cannot authorize another operation.');return {projectId:scope.projectId,principalId,actorKind:'human',identity:person,agentId,
    permissions:!mutating?[]:['conformance.context','conformance.decide','phase.reject','project.enroll','configuration.approve','story.create','source.bind','source.baseline.retain','phase.enter','phase.context.read','phase.prepare','phase.draft.read',
      'phase.draft.write','phase.draft.rebase','phase.source.retain','phase.checks.run','phase.publish','phase.submit','phase.approve']};}},
  clock={now(){if(!mutating)throw Error('Replay cannot restamp an accepted record.');return '2026-11-10T05:00:00.000Z';}},common={records,content,scope,workId,authority,access,clock},
  json=async ref=>JSON.parse(Buffer.from((await content.read(scope,ref)).data)),publish=phaseId=>({phaseId,authored:'governed-agent',channel:'copilot-host'}),
  sourceFile='// @clause:CONVERTER:REQ-001 Convert an integer into hexadecimal.\n// @clause:CONVERTER:AC-001 Return FF for 255.\nexport const convert=value=>value.toString(16).toUpperCase();\n',
  testFile="import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:CONVERTER:AC-001\ntest('converts the approved value',()=>assert.equal(convert(255),'FF'));\n",
  conformance=verdict=>'# Conformance\n\n## Agent brief\n\nReview the approved Code and original test execution; no new test was run in this phase.\n\n| Clause ID | Verdict |\n| --- | --- |\n| CONVERTER:REQ-001 | '+verdict+' |\n| CONVERTER:AC-001 | '+verdict+' |\n';
try{
  let engine,localContent;
  if(mutating){
    const local={kind:'machine-local',deviceId:'installed-conformance-device'};
    localRecords=await createFilesystemNamespaceStore({root:path.resolve('local-records'),binding:local,create:fresh});
    localDatabase=new DatabaseSync('local-content.db');localContent=createSqliteContentStore({database:localDatabase,binding:local,create:fresh});
    if(fresh){await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'test'));
      await writeFile(path.join(root,'src/converter.js'),'export const convert=value=>String(value);\n');await writeFile(path.join(root,'test/converter.test.js'),'// Original tests.\n');}
    const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('@sdk-name@/sources/filesystem'),
      {createNodeCheckExecutionUnit}=await import('@sdk-name@/testing/execution'),{createNodeExecutionOwner}=await import('@sdk-name@/execution/runtime'),
      source=await createFilesystemSourceUnit({root,id:'installed-converter-source',projectId:scope.projectId,repositoryId:'app'}),
      sourceReader=await createFilesystemSourceContentReader({root,id:'installed-converter-bytes',source:source.descriptor}),
      executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
      environment={NODE_OPTIONS:'--test-reporter='+import.meta.resolve('@sdk-name@/testing/node-test-reporter'),SINGULARITY_FLOW_NODE_TEST_ROOT:root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
      raw=await createNodeCheckExecutionUnit({id:'installed-converter-check',root,projectId:scope.projectId,repositoryId:'app',content,
        command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:value=>value.manifestSha256}),
      checks={owner:createNodeExecutionOwner({hostId:'installed-code-host'}),bindings:[{phaseId:'build',commandId:'node-tests',repositoryId:'app',executable:'node',executableSha256,environment,
        unit:{...raw,start(task){starts++;return raw.start(task);}}}]};
    engine=createNamespaceEngine({...common,working:{records:localRecords,content:localContent},sources:[source],sourceReaders:[sourceReader],checks});
  }else engine=createNamespaceEngine(common);
  async function write(phaseId,text){try{await engine.run('phase.prepare',{phaseId});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
    await engine.run('phase.draft.rebase',{operationId:stage+'-rebase-'+phaseId,workId,phaseId,expectedRevision:error.details.revision,confirm:error.details.confirm,
      reason:'Continue the preserved generation after its original human-approved return.'});}
    const {manifest}=await engine.run('phase.draft.read',{phaseId});await engine.run('phase.draft.write',{operationId:stage+'-write-'+phaseId+'-'+(++edits),workId,phaseId,
      expectedRevision:manifest.draft.revision,content:(await localContent.put(scope,'local',Buffer.from(text))).reference,reason:'Complete this exact generation.'});}
  async function approveSubmitted(phaseId){
    const {manifest}=await engine.run('phase.review',{phaseId}),binding=manifest.reviewBinding,original={principalId,person,agentId};
    principalId='independent-reviewer';person={name:'Reviewer',email:'reviewer@example.test'};agentId=null;
    try{const vote=await engine.run('phase.approve',{phaseId,confirmation:{workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
      assert.equal(vote.approval.selfApproval,false);return vote;}finally{({principalId,person,agentId}=original);}}
  async function approve(phaseId,decisionValues){await engine.run('phase.submit',{phaseId,...(decisionValues?{decisionValues}:{})});return approveSubmitted(phaseId);}
  async function publication(phase,generation){const packet=JSON.parse((await engine.run('document.read',{reference:{kind:'story-document',id:'REVIEW-'+phase+'-GEN-'+generation,workId}})).document.content.text),
    value=await json(packet.publication.record),policy=value.policyEvidence.find(row=>phase==='build'?row.kind.startsWith('code-delivery/'):row.kind==='conformance/v1'),manifest=await json(policy.record);
    return {binding:packet.publication,value,policy,manifest,report:await json(manifest.report)};}
  let output={checkpoint:stage};
  if(stage==='setup'){
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
          validate:{...base,label:'Validate',artifact:{path:'artifacts/validate/evidence.md',kind:'conformance-report'},writeScope:'artifact-only',inputs:[{phase:'build'}],testEvidenceFrom:'build',...(humanReturn?{approval:{...approval,rejectTo:['build','validate']}}:{})}},
        workTypes:{delivery:{label:'Converter',phases:['intake','design','build','validate'],plannedClaims:{mode:'required',clausePhases:['intake'],owners:{build:'design'}},...(rework?{decisions:[{id:'quality',label:'Quality review',kind:'loop',after:'validate',inputs:[{name:'verdict',values:['Pass','Repair']}],goal:{verdict:'Pass'},back:'build',maxRounds:1}]}:{})}}},
        agents:[{id:'analyst',label:'Analyst',phases:['intake','design','build'],defaultFor:['intake','design','build'],mode:'read-write',body,skills:[],instructions:[]},
          {id:'verifier',label:'Verifier',phases:['validate'],defaultFor:['validate'],mode:'read-write',body,skills:[],instructions:[]}],skills:[],instructions:[],templates:[{path:'singularity/templates/phase.md',body}],files:[]},
      configuration=(await content.put(scope,'config',Buffer.from(JSON.stringify(packet)))).reference;

    await engine.run('configuration.approve',{operationId:'approve-config',source:configuration,expectedRevision:null,confirm:configuration.sha256,reason:'Reviewed all dependencies.'});
    await engine.run('story.create',{operationId:'create',workId,title:'Converter',workTypeId:'delivery',configurationId:'approve-config',
      source:(await content.put(scope,'state',Buffer.from('Convert integers into hexadecimal and retain its approved example test.'))).reference});
    await write('intake','# Specification\n\n[CONVERTER:REQ-001] Convert an integer into hexadecimal.\n\n[CONVERTER:AC-001] Given 255, conversion returns FF.\n');
    await engine.run('phase.publish',publish('intake'));await approve('intake');progress('specification approved');
    await write('design','# Plan\n\n## Agent brief\n\nImplement the approved converter and regression.\n\n| Clause | Expected paths | Planned tests |\n| --- | --- | --- |\n'
      +'| CONVERTER:REQ-001 | `src/converter.js` | `test/converter.test.js` |\n| CONVERTER:AC-001 | `src/converter.js` | `test/converter.test.js` |\n');
    await engine.run('phase.publish',publish('design'));const planned=await approve('design');progress('plan approved');
    await engine.run('source.bind',{operationId:'select-source',workId,expectedRevision:planned.revision,repositories:['app'],reason:'Select the independently planned repository.'});
    await engine.run('source.baseline.retain',{operationId:'original-source',workId,sourceBindingId:'select-source'});
    await write('build','# Implementation\n\n## Agent brief\n\nThe converter and its exact pinned regression implement the approved example.\n');
    await writeFile(path.join(root,'src/converter.js'),sourceFile);await writeFile(path.join(root,'test/converter.test.js'),testFile);
    await engine.run('phase.source.retain',{operationId:'current-source',workId,phaseId:'build'});
    assert.equal((await engine.run('phase.checks.run',{operationId:'run-source-tests',workId,phaseId:'build'})).checks[0].tests.passed,1);
    await engine.run('phase.publish',publish('build'));await approve('build');assert.equal(starts,1);progress('original Code approved');
  }else if(stage==='draft-partial'){
    await write('validate',conformance('partial'));await engine.run('phase.publish',publish('validate'));assert.equal(starts,0);progress('partial report retained');
  }else if(stage==='return'){
    await engine.run('phase.submit',{phaseId:'validate'});const {manifest}=await engine.run('phase.review',{phaseId:'validate'});
    principalId='independent-reviewer';person={name:'Reviewer',email:'reviewer@example.test'};agentId=null;
    const request={phaseId:'validate',target:'build',reason:'Repair the disclosed gap with another actual boundary regression and a fresh test run.',confirm:manifest.reviewBinding.packetSha256},
      result=await engine.run('phase.reject',request);
    assert.equal(result.currentPhase,'build');assert.equal(result.changeRequest.id,'CR-001');
    await writeFile('human-return.json',JSON.stringify({request,result}));progress('human return retained');
  }else if(stage==='decide-requirement'||stage==='decide-acceptance'){
    principalId='independent-reviewer';person={name:'Reviewer',email:'reviewer@example.test'};agentId=null;
    const context=await engine.run('conformance.context',{phaseId:'validate'}),requirement=stage==='decide-requirement',
      request={phaseId:'validate',expected:context.expected,clauseId:requirement?'CONVERTER:REQ-001':'CONVERTER:AC-001',ownerPhase:'build',
        outcome:requirement?'accept-risk':'dismiss',...(requirement?{expires:'2026-11-11T05:00:00.000Z'}:{}),
        reason:requirement?'The upstream owner accepts the explicitly disclosed limitation until its dated repair.':'The retained execution proves the assertion; this report deliberately keeps its conservative partial label.'},
      result=await engine.run('conformance.decide',request),records=requirement?[]:JSON.parse(await readFile('human-decisions.json','utf8'));
    assert.equal(result.record.outcome.verdict,'partial');records.push({request,result});await writeFile('human-decisions.json',JSON.stringify(records));progress('upstream owner decision retained');
  }else if(stage==='review'){
    await write('validate',conformance('partial'));await engine.run('phase.publish',publish('validate'));await approve('validate',{verdict:'Repair'});assert.equal(starts,0);progress('return approved');
  }else if(stage==='repair-write'){
    await write('build','# Repaired implementation\n\n## Agent brief\n\nPreserve the original converter and add another executable boundary regression with a fresh test run.\n');
    await writeFile(path.join(root,'test/converter.test.js'),testFile+"\ntest('converts the next boundary',()=>assert.equal(convert(256),'100'));\n");
    await engine.run('phase.source.retain',{operationId:'successor-source',workId,phaseId:'build'});
    assert.equal((await engine.run('phase.checks.run',{operationId:'successor-tests',workId,phaseId:'build'})).checks[0].tests.passed,2);assert.equal(starts,1);progress('successor tests retained');
  }else if(stage==='repair-publish'||stage==='repair-approve'){
    if(stage==='repair-publish')await engine.run('phase.publish',publish('build'));
    if(!humanReturn||stage==='repair-approve'){await approve('build');const p=await publication('build',2);
    assert.equal(p.policy.kind,humanReturn?'code-delivery/v3':'code-delivery/v2');assert.equal(p.manifest.schemaVersion,humanReturn?3:2);assert.equal(p.report.preflight.history.predecessor.publication.generation,1);
    assert.deepEqual(p.report.preflight.history.repositories[0].changes.map(row=>row.path),['test/converter.test.js']);
    assert.equal(await readFile(path.join(root,'src/converter.js'),'utf8'),sourceFile);assert.equal(starts,0);progress('successor Code approved');}
  }else if(stage==='publish-final'){
    await write('validate',conformance('matched'));await engine.run('phase.publish',publish('validate'));progress('conformance published');
  }else if(stage==='submit-final'){
    await engine.run('phase.submit',{phaseId:'validate',...(rework?{decisionValues:{verdict:'Pass'}}:{})});progress('conformance submitted');
  }else if(stage==='approve-final'){
    await approveSubmitted('validate');progress('conformance approved');
  }else if(stage==='finish'){
    const p=await publication('validate',repair?2:1);
    assert.equal(p.value.checks,null);assert.equal(p.report.gaps.length,partial?2:0);assert.ok(p.report.rows.at(-1).evidence.every(row=>row.witnesses.every(witness=>typeof witness.id==='string'&&witness.id)));assert.equal(p.report.inputs.inputs[0].tests[0].tests.passed,repair?2:1);assert.equal(starts,0);
    output={publication:p.binding,report:p.report};await writeFile('publication.json',JSON.stringify(output));await rm(root,{recursive:true,force:true});progress('conformance approved');
  }else if(stage==='replay-return'||stage==='replay-decisions'){
    principalId='independent-reviewer';person={name:'Reviewer',email:'reviewer@example.test'};agentId=null;
    if(humanReturn){const saved=JSON.parse(await readFile('human-return.json','utf8'));assert.deepEqual(await engine.run('phase.reject',saved.request),saved.result);}
    if(partial)for(const saved of JSON.parse(await readFile('human-decisions.json','utf8')))assert.deepEqual(await engine.run('conformance.decide',saved.request),saved.result);
  }else if(stage==='replay-build'||stage==='replay-validate'){
    assert.equal((await engine.run('phase.publish',publish(stage==='replay-build'?'build':'validate'))).status,'retained');
  }else if(stage==='replay'){
    output=JSON.parse(await readFile('publication.json','utf8'));
    const {manifest}=await engine.run('phase.review.resources',{phaseId:'validate'}),resource=manifest.resources.find(row=>row.kind==='conformance');assert.ok(resource);
    assert.deepEqual(JSON.parse((await engine.run('document.read',{reference:resource.reference})).document.content.text),output.report);assert.equal(starts,0);progress('shared-only replay');
  }else throw Error('Unknown test stage: '+stage);
  process.stdout.write(JSON.stringify(output));
}finally{localRecords?.close?.();localDatabase?.close();records.close?.();database.close();guard.deregister();}
