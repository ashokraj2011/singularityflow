/** Empty real storage is enrolled and configured through registered operations, never seed writes. */
import { namespaceProjectFixture } from './namespace-project-fixture.mjs';
import { createNamespaceConfigurationEngine } from '../../src/engine-storage/namespace-configuration.mjs';
import { NAMESPACE_CONFIGURATION_SOURCE_FORMAT } from '../../src/kernel/namespace-configuration.mjs';
import { NAMESPACE_CONFIGURATION_HEAD_KEY } from '../../src/engine-storage/namespace-configuration-contract.mjs';

export async function namespaceConfigurationFixture(t,{backend='filesystem',enroll=true}={}) {
  const f=await namespaceProjectFixture(t,{backend});
  if(enroll)await f.engine.run('project.enroll',{operationId:'initial-enrollment'});
  Object.assign(f.control,{permissions:['project.enroll','configuration.approve'],actorKind:'human',reviewCalls:0,reviewHook:()=>{}});
  const access={async current(request){f.control.reviewCalls++;await f.control.reviewHook(f.control.reviewCalls,request);
    return {projectId:f.scope.projectId,principalId:f.control.principalId,permissions:[...f.control.permissions],actorKind:f.control.actorKind};}};
  const make=(options={})=>createNamespaceConfigurationEngine({records:f.records,content:f.content,scope:f.scope,authority:f.authority,access,clock:f.clock,...options});
  const putText=async text=>(await f.content.put(f.scope,'config',Buffer.from(text))).reference;
  const source={schemaVersion:1,format:NAMESPACE_CONFIGURATION_SOURCE_FORMAT,
    definition:{version:2,planning:{enabled:false},templatesRoot:'singularity/templates',phases:{intake:{label:'Intake',artifact:{path:'artifacts/intake/plan.md'},defaultTemplate:'intake.md'}},
      workTypes:{simple:{label:'Simple',phases:['intake']}}},
    agents:[{id:'analyst',label:'Analyst',phases:['intake'],defaultFor:['intake'],mode:'read-write',body:await putText('Produce an observable, evidence-grounded requirement.\n'),skills:['framework'],instructions:['coding']}],
    skills:[{id:'framework',body:await putText('Use the repository framework and its compatibility constraints.\n'),skills:[],instructions:['coding','testing']}],
    instructions:[{id:'coding',body:await putText('Preserve public contracts.\n')},{id:'testing',body:await putText('Retain genuine execution evidence.\n')}],
    templates:[{path:'singularity/templates/intake.md',body:await putText('# Intake\n\n## Requirements\n\n## Acceptance criteria\n')}],files:[]};
  const store=async value=>putText(JSON.stringify(value)+'\n');
  const reference=await store(source);
  const inputs={operationId:'configuration-1',source:reference,expectedRevision:null,confirm:reference.sha256,reason:'Reviewed the complete workflow, roles and resource dependencies.'};
  const head=()=>f.records.read(f.scope,'config',NAMESPACE_CONFIGURATION_HEAD_KEY);
  return {...f,access,make,source,store,putText,inputs,head,engine:make()};
}
