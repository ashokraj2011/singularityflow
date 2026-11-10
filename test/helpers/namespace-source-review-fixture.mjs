import {namespaceEngineFixture} from './namespace-engine-fixture.mjs';
const specification='# Specification\n\n## Scenarios\n### S1 — Retain a document\nGiven a request, when retained, then its reviewed document remains available.\n\n## Requirements\nRetain the reviewed document. [COMPOSED:REQ-001]\n\n## Acceptance criteria\nThe reviewed result is available. [COMPOSED:AC-001]\n';
export async function namespaceSourceReviewFixture(t,backend='filesystem',{document=null,clarification=false}={}){
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    const phase=source.definition.phases.intake;phase.artifact.kind='requirements';phase.specificationQuality={mode:'off'};phase.clarification={mode:clarification?'required':'off',markers:{mode:'off'}};
    source.definition.spec={mode:'enforce',namespace:'COMPOSED',coverage:'record',acceptance:'presence'};
    source.definition.workTypes.simple.omits=source.definition.workTypes.simple.omits.filter(row=>row.responsibility!=='scope');
    source.definition.workTypes.simple.sourceReview={mode:'enforce',phases:['intake'],reviewerAgent:'source-reviewer'};
    source.agents.push({...structuredClone(source.agents[0]),id:'source-reviewer',label:'Independent source reviewer',mode:'read-only-review',defaultFor:[]});
  }});
  f.control.permissions.push('source-review.context','source-review.record','source-review.decide','story.next','story.guide');await f.bootstrap();
  if(document){f.control.permissions.push('story.document.attach');
    const bytes=(await f.local.content.put(f.scope,'local',Buffer.from(document.text))).reference;
    await f.engine.run('story.document.attach',{operationId:'attach-review-notes',workId:f.workId,documentId:'review-notes',name:'Review notes',mimeType:'text/plain',encoding:'utf8',content:bytes,reason:'Attach local source notes before authoring.'});}
  if(clarification){f.control.permissions.push('clarification.record');const status=await f.engine.run('clarification.status',{phaseId:'intake'});
    await f.engine.run('clarification.record',{operationId:'human-reviewed-scope',workId:f.workId,phaseId:'intake',contextSha256:status.context.sha256,responses:[{question:'What remains available?',answer:'The exact reviewed document remains available to the next phase.'}]});}
  await f.engine.run('phase.prepare',{phaseId:'intake'});const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),
    content=(await f.local.content.put(f.scope,'local',Buffer.from(specification))).reference;
  await f.engine.run('phase.draft.write',{operationId:'author-reviewed-specification',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,content,
    reason:'Author the actual scope and acceptance scenario.'});
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});return f;
}
export function namespaceSourceReviewReport(manifest){return {schemaVersion:1,resultType:'source-grounded-review',kind:'specification',binding:manifest.binding,
  reviewer:{agentId:'source-reviewer',readOnly:true},sourcesReviewed:['story-source'],findings:[],rows:[{id:'retain-result',sourceId:'story-source',line:3,
    quote:'Retain an observable reviewed document.',outcome:'covered',scenarioId:'S1',clauseIds:['COMPOSED:REQ-001','COMPOSED:AC-001']}]};}
