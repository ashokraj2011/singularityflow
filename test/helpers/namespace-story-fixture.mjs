/** Real empty stores reach genesis only through enrollment, approval and registered creation. */
import { namespaceConfigurationFixture } from './namespace-configuration-fixture.mjs';
import { createNamespaceStoryEngine } from '../../src/engine-storage/namespace-story.mjs';
import { namespaceLifecycleStoryKey } from '../../src/engine-storage/namespace-lifecycle-reader.mjs';

export async function namespaceStoryFixture(t,{backend='filesystem',approve=true,workId='story-1'}={}) {
  const f=await namespaceConfigurationFixture(t,{backend});
  const definition=structuredClone(f.source);
  definition.definition.approvalAuthorities={reviewers:{label:'Reviewers',members:[{email:'reviewer@example.test'}]}};
  definition.definition.phases.intake.approval={authorities:['reviewers'],minimum:1,rejectTo:['intake']};
  definition.definition.workTypes.simple.omits=['scope','plan','implement','verify'].map(responsibility=>({
    responsibility,reason:'This workflow creates a reviewed intake document, without defining or delivering application requirements.',authority:'reviewers'}));
  const configSource=await f.store(definition);
  const configurationInputs={...f.inputs,source:configSource,confirm:configSource.sha256};
  const approval=approve?await f.engine.run('configuration.approve',configurationInputs):null;
  Object.assign(f.control,{permissions:[...f.control.permissions,'story.create'],storyCalls:0,storyHook:()=>{},
    actorKind:'human',creator:{name:'Example reviewer',email:'reviewer@example.test',login:null}});
  const access={async current(request){f.control.storyCalls++;await f.control.storyHook(f.control.storyCalls,request);
    return {projectId:f.scope.projectId,principalId:f.control.principalId,actorKind:f.control.actorKind,
      identity:structuredClone(f.control.creator),permissions:[...f.control.permissions]};}};
  const source=(await f.content.put(f.scope,'state',Buffer.from('# Story\n\nAdd a converter and retain boundary tests.\n'))).reference;
  const inputs={operationId:'create-story-1',workId,title:'Converter',workTypeId:'simple',configurationId:f.inputs.operationId,source};
  const make=(options={})=>createNamespaceStoryEngine({records:f.records,content:f.content,scope:f.scope,workId,authority:f.authority,access,clock:f.clock,...options});
  const head=()=>f.records.read(f.scope,'state',namespaceLifecycleStoryKey(workId));
  return {...f,approval,configurationEngine:f.engine,configurationInputs,configurationSource:definition,inputs,make,head,engine:make()};
}
