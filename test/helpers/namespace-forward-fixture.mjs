/** Historical document amendments over actual registered publications and independent votes. */
import {namespaceEngineFixture} from './namespace-engine-fixture.mjs';
export async function namespaceForwardFixture(t,{backend='filesystem',configure=null,setup=null}={}){
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    const definition=source.definition;
    definition.inputsMode='enforce';
    for(const [id,inputs]of [['intake',[]],['design',['intake']],['delivery',['intake','design']]]){
      definition.phases[id]={label:id,artifact:{path:'artifacts/'+id+'/result.md',kind:'phase-document'},defaultTemplate:'intake.md',
        inputs,approval:{authorities:['reviewers'],minimum:1,rejectTo:['intake','design',id],allowSelfApproval:false},
        authoring:{allowedProducers:['governed-agent','human']}};
    }
    definition.workTypes.simple.phases=['intake','design','delivery'];
    source.agents[0].phases=['intake','design','delivery'];source.agents[0].defaultFor=[...source.agents[0].phases];
    if(configure)configure(source);
  }});
  if(setup)await setup(f);
  f.control.permissions.push('forward-amendment.propose','forward-amendment.decide','forward-amendment.revalidate','upstream.list','upstream.raise','upstream.decide',
    'decisions.list','story.next','story.guide');
  await f.bootstrap();await f.author('intake');await f.review('intake');await f.author('design');await f.review('design');f.asAuthor();
  async function propose({phaseId='intake',operationId='propose-amendment',upstreamIssue=null,text=null}={}){
    const snapshot=await f.capture(),previous=snapshot.workflow.phases[phaseId].artifacts[0],bytes=await f.content.read(f.scope,{namespace:'evidence',sha256:previous.sha256,bytes:previous.size}),
      original=Buffer.from(bytes.data).toString('utf8'),content=(await f.local.content.put(f.scope,'local',Buffer.from(text??original+'\nAn amended observable requirement preserves original input provenance.\n'))).reference,
      input={workId:f.workId,phaseId,operationId,content,upstreamIssue,reason:'Correct the historical document without reopening unrelated work.'};
    return {input,result:await f.engine.run('forward-amendment.propose',input),content,original};
  }
  async function decide({amendmentId='FAM-001',decision='approve',operationId='decide-amendment'}={}){
    f.asReviewer();const input={workId:f.workId,operationId,amendmentId,decision,confirmation:amendmentId,
      reason:'The independent human reviewed this exact replacement and its input bindings.'};
    return {input,result:await f.engine.run('forward-amendment.decide',input)};
  }
  return {...f,propose,decide};
}
