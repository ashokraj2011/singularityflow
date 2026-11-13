/** Independently inventoried known-failure values. Evidence and human authority are supplied by their owners. */
import {canonicalJson,textDigestCapability} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {testRecoveryPolicies} from './test-recovery.mjs';
const fail=(message,code='KNOWN_TEST_RISK_NOT_ELIGIBLE',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const under=(file,root)=>file===root||file.startsWith(root+'/');
const compare=(a,b)=>a<b?-1:a>b?1:0;
const relative=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&!/[\\:*?\[\]{}]/u.test(value)
  &&!value.split('/').some(part=>['','..','.'].includes(part))&&!value.startsWith('-');
export function namespaceKnownTestRecoveryPolicies(port){
  const digest=textDigestCapability(port),trp=testRecoveryPolicies(port),hash=value=>'sha256:'+digest.sha256Utf8(canonicalJson(value));
  function testInputCases(occurrences){
    const cases=occurrences.map(row=>({file:row.file,name:row.name,ancestorTitles:row.ancestorTitles??[],line:row.line??null}))
      .sort((a,b)=>compare(canonicalJson(a),canonicalJson(b)));
    return {count:cases.length,sha256:hash(cases),names:cases.slice(0,32).map(row=>row.name)};
  }
  function observed({workId,phaseId,generation,repositoryId,command,commands,declaration,snapshot,qualification,parsed,reportSha256s,at,configuration,sourceRevision,additionalTestInputs=[]}){
    if(declaration?.adapter!=='node-test-junit-v1'||declaration.dependencyScope!=='repository-and-node-builtins-only'
      ||!Array.isArray(declaration.tests)||!declaration.tests.length||declaration.tests.length>10000
      ||declaration.tests.some(row=>!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>256||!relative(row.path)
        ||typeof row.name!=='string'||!row.name.trim())
      ||!Array.isArray(declaration.baselineMutableRoots??[])||(declaration.baselineMutableRoots??[]).some(root=>!relative(root))
      ||command.result?.adapter!=='junit-xml'||command.workingDirectory&&command.workingDirectory!=='.'
      ||command.argv?.[1]!=='--test'||command.argv[2]!=='--test-reporter=junit'||command.argv.length<4)
      fail('Known-failure review needs an independently approved direct native Node JUnit inventory.');
    const files=command.argv.slice(command.argv[3]==='--'?4:3).map(file=>file.replace(/^\.\//u,'')),expected=declaration.tests;
    if(files.some(file=>!relative(file))
      ||new Set(files).size!==files.length||files.length>256||files.some(file=>!expected.some(test=>test.path===file))
      ||expected.some(test=>!files.includes(test.path))||new Set(expected.map(test=>test.id)).size!==expected.length
      ||new Set(expected.map(test=>canonicalJson([test.path,test.name]))).size!==expected.length)fail('The full configured command must match the independent file and case inventory.');
    if(qualification?.profile!=='sflow-node-check-environment/v1'||!qualification.hostId||!qualification.platform||!qualification.arch)
      fail('Run the command through the environment-qualified SGOS executor.','KNOWN_TEST_ENVIRONMENT_REQUIRED');
    if(!parsed||parsed.cases.length!==expected.length||parsed.tests.discovered!==expected.length||parsed.tests.skipped!==0)
      fail('Every independently expected case must execute exactly once without missing, extra or skipped cases.');
    const seen=new Set(),cases=parsed.cases.map(row=>{
      const test=expected.find(test=>test.path===row.file&&test.name===row.name),file=test&&snapshot.entries.find(file=>file.path===test.path);
      if(!test||seen.has(test.id)||!file||!['passed','failed'].includes(row.outcome))fail('The raw report does not match the independent case inventory.',
        'KNOWN_TEST_RISK_NOT_ELIGIBLE',{file:row.file,name:row.name,outcome:row.outcome});
      seen.add(test.id);return {id:test.id,outcome:row.outcome,semanticsSha256:hash({path:test.path,name:test.name,sourceSha256:'sha256:'+file.sha256}),causeSha256:row.causeSha256};
    }).sort((a,b)=>compare(a.id,b.id));
    const protectedPath=file=>/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|config|configuration|node_modules|vendor|target|build|dist|\.venv|venv)(?:\/|$)/iu.test(file)
      ||/(?:^|\/)(?:conftest|pytest|setup|settings|pom|package|requirements|pyproject|tox|Pipfile|Cargo|go)(?:[.-]|$)/iu.test(file)
      ||/(?:^|[._-])(?:test|spec|config)(?:[._-]|$)/iu.test(file.split('/').at(-1))||expected.some(test=>test.path===file),
      stable=snapshot.entries.filter(file=>!additionalTestInputs.some(input=>input.repositoryId===repositoryId&&input.path===file.path)
        &&(protectedPath(file.path)||!(declaration.baselineMutableRoots??[]).some(root=>under(file.path,root))||!/\.(?:[cm]?js|jsx|tsx?|py|java)$/u.test(file.path))),
      commandSha256=hash(command),commandInventorySha256=hash(commands),selectorSha256=hash({command:command.argv,files}),
      environment={hostId:qualification.hostId,platform:qualification.platform,arch:qualification.arch,runtimeSha256:qualification.runtimeSha256,
        dependencySha256:hash(snapshot.entries),runnerSha256:commandSha256,adapterSha256:hash('node-test-junit-v1'),
        configurationSha256:hash({configuration,commands,environment:qualification.environmentSha256}),externalDependenciesSha256:null},
      compatibility=hash({stable,declaration,environment:{...environment,dependencySha256:hash(stable)}});
    return {subject:{workId,repositoryId,phaseId,generation,validationEpoch:1},obligationId:command.id,sourceRevision,sourceManifestSha256:hash(snapshot.entries),
      commandInventorySha256,commandSha256,selectorSha256,dependencies:[{id:'application-source-and-dependencies',sha256:hash(snapshot.entries)},
        {id:'baseline-compatibility',sha256:compatibility}],environment,startedAt:at,completedAt:at,reportStatus:'current',reportSha256s,
      expectedTestIds:cases.map(row=>row.id),cases,counts:{...parsed.tests,notRun:0},identityCompleteness:'complete',
      observedOutcome:parsed.tests.failed?'failed':'passed',diagnostics:[],executionOrigin:'executed'};
  }
  function project({workId,phaseId,generation,policy,configuration,recovery,before,after,baselineExit,currentExit}){
    const authoritySha256=hash({configuration,policy}),wirePolicy={enabled:true,authoritySha256,enabledRiskCategories:policy.enabledRiskCategories,
      maxRiskDays:policy.maxRiskDays,allowEvidenceReuse:policy.allowEvidenceReuse,maxEvidenceAgeSeconds:policy.maxEvidenceAgeSeconds,requiredApproval:true},
      envelope=(kind,id,subject,at,principal)=>({schemaVersion:1,kind,id,subject,createdAt:at,issuer:{principal,channel:'namespace-known-failure-review'},
        provenance:{authorityRef:authoritySha256,evidenceRefs:[]}}),
      baseline=trp.sealTrpRecord({...envelope('test-baseline-manifest','baseline-'+hash(before).slice(7,39),{...before.subject,generation:0},before.completedAt,'retained-check-executor'),
        ...before,subject:{...before.subject,generation:0},agreementSha256:null,selectionSha256:hash({command:before.commandSha256,inventory:before.expectedTestIds}),
        processExitCode:baselineExit,preFeatureBase:before.sourceRevision,inventoryTestIds:before.expectedTestIds,inventoryComplete:true}),
      agreement=trp.sealTrpRecord({...envelope('story-test-recovery-agreement','agreement-'+recovery.contextSha256.slice(7,39),{workId},recovery.recordedAt,recovery.actor),
        revision:recovery.revision,parentRevision:null,policyAuthoritySha256:authoritySha256,confirmedPlanSha256:recovery.contextSha256,
        repair:{maxDistinctAutomaticAttempts:policy.maxDistinctAutomaticAttempts},repositories:[{repositoryId:after.subject.repositoryId,required:true,codeBearing:true,
          baselineDisposition:'accept-known-failures',baselineScope:'all-configured',baselineRefs:[baseline.recordSha256],riskDecisionRefs:[],
          execution:{mode:'all-configured',moduleExpansion:'deny',fullSuiteExpansion:'deny',knownFailureHandling:'observe'},
          mandatoryObligations:[{id:after.obligationId,kind:'test',nonWaivable:false,phaseIds:[phaseId],transitions:['publish','submit','approve','downstream','replay']}]}]}),
      selection=trp.sealTrpRecord({...envelope('test-selection-manifest','selection-'+hash(after).slice(7,39),after.subject,after.completedAt,'retained-check-executor'),
        agreementSha256:agreement.recordSha256,requestedMode:'all-configured',effectiveMode:'all-configured',candidateDeltaSha256:hash({before:before.sourceRevision,after:after.sourceRevision}),
        commandInventorySha256:after.commandInventorySha256,commandSha256:after.commandSha256,selectorSha256:after.selectorSha256,
        selectedTestIds:after.expectedTestIds,selectedSuites:[],inventoryTestIds:after.expectedTestIds,reasons:after.expectedTestIds.map(target=>({target,reason:'full-configured-command'})),
        expansion:'none',fullSuiteEquivalent:true,confirmationSha256:null,exclusions:[],uncoveredAreas:[],impactComplete:true}),
      observation=trp.sealTrpRecord({...envelope('phase-validation-observation','run-'+hash(after).slice(7,39),after.subject,after.completedAt,'retained-check-executor'),...after,
        agreementSha256:agreement.recordSha256,selectionSha256:selection.recordSha256,processExitCode:currentExit});
    return {policy:wirePolicy,agreement,baseline,selection,observation};
  }
  function risk(projection,record,{principal,authorizationRef}){
    const original=trp.buildBaselineRiskDecision(projection.agreement,projection.baseline,{authority:{policy:projection.policy},
      choices:{reason:record.reason,expiresAt:record.expiresAt,followUpOwner:record.followUpOwner,remediationRef:record.remediationRef},
      principal,planDigest:record.contextSha256,createdAt:record.recordedAt,transitions:['publish','submit','approve','downstream','replay']}),
      {recordSha256,...value}=original;
    return trp.sealTrpRecord({...value,issuer:{principal,channel:'namespace-known-failure-review'},authorizationRef});
  }
  function eligible(projection){const baseline=projection.baseline,compatible=baseline.dependencies.filter(row=>row.id==='baseline-compatibility');
    return trp.knownFailureMatches(projection.observation,baseline,{applicability:{
      dependencies:compatible.length?compatible:baseline.dependencies,
      acceptedFailures:baseline.cases.filter(row=>row.outcome==='failed').map(row=>({testId:row.id,semanticsSha256:row.semanticsSha256,causeSha256:row.causeSha256})),
      maxFailed:baseline.counts.failed}},projection.selection);
  }
  function comparison(projection){const before=projection.baseline,after=projection.observation,previous=new Map(before.cases.map(row=>[row.id,row]));
    return {eligible:eligible(projection),commandMatches:before.commandSha256===after.commandSha256&&before.selectorSha256===after.selectorSha256,
      protectedDependenciesMatch:before.dependencies.find(row=>row.id==='baseline-compatibility')?.sha256===after.dependencies.find(row=>row.id==='baseline-compatibility')?.sha256,
      qualifiedEnvironmentMatches:hash({...before.environment,dependencySha256:null})===hash({...after.environment,dependencySha256:null}),
      changedSemantics:after.cases.filter(row=>row.semanticsSha256!==previous.get(row.id)?.semanticsSha256).slice(0,32).map(row=>row.id),
      newFailures:after.cases.filter(row=>row.outcome==='failed'&&previous.get(row.id)?.outcome!=='failed').slice(0,32).map(row=>row.id),
      changedFailureCauses:after.cases.filter(row=>row.outcome==='failed'&&row.causeSha256!==previous.get(row.id)?.causeSha256).slice(0,32).map(row=>row.id),
      missingCases:before.expectedTestIds.filter(id=>!after.expectedTestIds.includes(id)).slice(0,32),
      skippedCases:after.cases.filter(row=>['skipped','not-run'].includes(row.outcome)).slice(0,32).map(row=>row.id)};
  }
  function state(rows,record,at){return rows.some(row=>row.revokes===record.id)?'revoked':Date.parse(at)>=Date.parse(record.expiresAt)?'expired':'active';}
  function confirm(workflow,request,facts,source){
    if(workflow.status!=='in_progress')fail('Review known failures while the Story is in progress.','RISK_STORY_CLOSED');
    const prior=workflow.namespaceKnownTestRisks??[];
    if(prior.length>=128)fail('The bounded known-failure review history needs explicit archival.','ENGINE_STORAGE_LIMIT');
    let record;
    if(request.revoke){if(!prior.some(row=>row.id===request.revoke))fail('The original known-failure decision does not exist.','TEST_RUN_RISK_UNKNOWN');
      record={schemaVersion:1,profile:'sflow-namespace-known-test-run-risk/v1',phase:request.phaseId,revokes:request.revoke,reason:request.reason,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,recordedAt:facts.at};
    }else{
      if(request.expectedContext!==source.context.sha256)fail('Review the exact baseline, independent inventory and failed execution.','KNOWN_TEST_RISK_CONTEXT_CHANGED');
      const expiresAt=/^\d{4}-\d{2}-\d{2}$/u.test(request.expires??'')?request.expires+'T23:59:59.999Z':request.expires;
      if(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.parse(facts.at)
        ||Date.parse(expiresAt)-Date.parse(facts.at)>source.maximumDays*86400000)fail('Use a future expiry within the pinned test-risk lifetime.','TEST_RUN_RISK_INVALID');
      if(prior.some(row=>row.id&&row.scopeSha256===source.context.value.scopeSha256&&state(prior,row,facts.at)==='active'))
        fail('This exact known-failure scope already has an active human decision.','KNOWN_TEST_RISK_ALREADY_CONFIRMED');
      record={schemaVersion:1,profile:'sflow-namespace-known-test-run-risk/v1',id:'KTR-'+String(prior.filter(row=>row.id).length+1).padStart(3,'0'),
        phase:request.phaseId,generation:source.generation,scopeSha256:source.context.value.scopeSha256,
        context:{profile:'sflow-namespace-known-test-risk-reference/v1',reference:source.context.reference,
          baseline:structuredClone(source.context.value.baseline),observed:structuredClone(source.context.value.observed)},contextSha256:source.context.sha256,
        expiresAt,reason:request.reason,followUpOwner:request.followUpOwner,remediationRef:request.remediationRef,
        actor:facts.actorId,authorityGroup:facts.authorityGroup,recordedAt:facts.at};
    }
    const proposed=structuredClone(workflow);proposed.namespaceKnownTestRisks=[...prior,record];proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,
      event:request.revoke?'known_test_risk_revoked':'known_test_risk_confirmed',phase:request.phaseId,detail:record.reason});
    return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
  }
  return Object.freeze({hash,testInputCases,observed,project,risk,eligible,comparison,state,confirm});
}
