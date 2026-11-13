/** Real document workflow, original source, human scope decisions and independent phase approvals. */
import {namespaceEngineFixture} from './namespace-engine-fixture.mjs';
export const obligationRiskReason='The original reviewers accept this documented inspection gap for the bounded trial; it is not a claim of passing tests.';
export async function namespaceObligationRiskFixture(t,{backend='sqlite',routed=false,secondCriterion=false}={}){
  const f=await namespaceEngineFixture(t,{backend,storyText:'# Request\n\nRetain the reviewed converter design.\n',configure:source=>{
    source.definition.spec={mode:'enforce',namespace:'COMPOSED-STORY',coverage:'off',acceptance:'presence'};
    source.definition.phases.intake.artifact.kind='requirements';
    source.definition.phases.intake.specificationQuality={mode:'off'};source.definition.phases.intake.clarification={mode:'off',markers:{mode:'off'}};
    const phase=(label,kind,from)=>({label,artifact:{path:'artifacts/'+from+'/'+kind+'.md',kind},defaultTemplate:'intake.md',writeScope:'artifact-only',
      inputs:[{phase:from}],specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:[from],allowSelfApproval:false}});
    source.definition.phases.verify=phase('Inspect the design','test-evidence','intake');
    source.definition.phases.release=phase('Close the reviewed delivery','phase-document','verify');
    source.definition.workTypes.simple.phases=['intake','verify','release'];
    source.definition.workTypes.simple.omits=source.definition.workTypes.simple.omits.filter(row=>['plan','implement'].includes(row.responsibility));
    if(routed)source.definition.workTypes.simple.decisions=[{id:'final-choice',label:'Close the trial',kind:'branch',after:'release',inputs:[{name:'result',values:['Done','Continue']}],
      routes:[{id:'close',label:'Finish',when:{result:'Done'},to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)},
        {id:'continue',label:'Continue',to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)}]}];
    source.agents[0].phases=['intake','verify','release'];source.agents[0].defaultFor=['intake','verify','release'];
  }});
  f.control.permissions.push('story.evidence','decision.risk','scope.context','decision.scope','decision.completeness','decision.applicability','decisions.list','decisions.record');
  await f.bootstrap();let count=0;
  async function write(phaseId,text,{submit=true}={}){
    f.asAuthor();try{await f.engine.run('phase.prepare',{phaseId});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
      await f.engine.run('phase.draft.rebase',{operationId:'risk-rebase-'+(++count),workId:f.workId,phaseId,expectedRevision:error.details.revision,
        confirm:error.details.confirm,reason:'Preserve the actual authored report after a retained human decision.'});}
    const draft=await f.engine.run('phase.draft.read',{phaseId}),content=(await f.local.content.put(f.scope,'local',Buffer.from(text))).reference;
    await f.engine.run('phase.draft.write',{operationId:'risk-author-'+(++count),workId:f.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content,reason:'Retain the reviewed document without inventing inspection or execution evidence.'});
    try{await f.engine.run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'});}catch(error){t.diagnostic(JSON.stringify(error.details));throw error;}
    if(submit)await f.engine.run('phase.submit',{phaseId,...(routed&&phaseId==='release'?{decisionValues:{result:'Done'}}:{})});
  }
  await write('intake','# Requirements\n\n[COMPOSED-STORY:REQ-001] Retain the reviewed converter design.\n\n## Acceptance criteria\n\n'
    +'[COMPOSED-STORY:AC-001] Given a converter design, its inspection records the original review.\n'
    +(secondCriterion?'\n[COMPOSED-STORY:AC-002] Given an independent inspection, record the boundary review.\n':''));
  await f.review('intake');f.asReviewer();
  const inventory=(await f.engine.run('scope.context',{})).manifest.inventory;
  for(const item of inventory.items.filter(row=>row.disposition==='unresolved'))await f.engine.run('decision.scope',{
    operationId:'risk-scope-'+(++count),item:item.id,disposition:'included',clauseIds:['COMPOSED-STORY:REQ-001','COMPOSED-STORY:AC-001'],reason:'The exact approved clauses carry this original design requirement.'});
  for(const responsibility of ['plan','implement'])await f.engine.run('decision.applicability',{operationId:'risk-applicability-'+responsibility,responsibility,
    reason:'This document trial retains a reviewed design; it contains no application implementation or delivery plan.'});
  await write('verify','# Inspection record\n\n## Agent brief\n\nThe reviewer examined the design but retained no criterion-bound inspection evidence. This report claims no test run or acceptance.\n');
  await f.review('verify');await write('release','# Final review\n\n## Agent brief\n\nClose this bounded document trial only after the original inspection obligations are resolved honestly.\n');f.asReviewer();
  const input=(obligationId='OBL:composed-story:verify:COMPOSED-STORY:AC-001',extra={})=>({operationId:'accept-original-obligation-risk',obligationId,category:'deferred-verification',expires:'2026-12-01',reason:obligationRiskReason,...extra});
  return {...f,write,riskInput:input};
}
