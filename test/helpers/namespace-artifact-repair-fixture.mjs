import {namespaceEngineFixture} from './namespace-engine-fixture.mjs';
export function artifactRepairConfiguration(source){
  source.definition.artifactSets={packet:{primary:'plan.md',members:[{path:'plan.md',role:'requirements',required:true},
    {path:'notes.txt',role:'supporting-evidence',required:true},{path:'stable.txt',role:'planning',required:true},
    {path:'extra/',role:'supporting-evidence'}]}};
  source.definition.phases.intake.artifactSet='packet';
}
export async function namespaceArtifactRepairFixture(t,backend='sqlite',{configure=null}={}){
  const f=await namespaceEngineFixture(t,{backend,configure:source=>{artifactRepairConfiguration(source);configure?.(source);}});
  f.control.permissions.push('phase.reject','phase.enter','phase.context.read','phase.prepublish','phase.artifact.inspect','phase.artifact.attach','phase.artifact.remove');
  async function attach(path,text,operationId){const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),
    content=(await f.local.content.put(f.scope,'local',Buffer.from(text))).reference;
    return f.engine.run('phase.artifact.attach',{operationId,workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
      memberPath:path,content,reason:'Retain the actual output bytes for this reviewed member.'});}
  async function start(){await f.bootstrap();await f.engine.run('phase.prepare',{phaseId:'intake'});
    const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),content=(await f.local.content.put(f.scope,'local',Buffer.from('# Reviewed document\n\nThis bundle records the observed request.\n'))).reference;
    await f.engine.run('phase.draft.write',{operationId:'write-original-primary',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
      content,reason:'Complete the actual primary document before review.'});
    await attach('notes.txt','Original reviewed notes.\n','attach-original-notes');await attach('stable.txt','Original stable planning.\n','attach-original-stable');
    await attach('extra/a.txt','Original first collection member.\n','attach-original-extra-a');
    await attach('extra/b.txt','Original second collection member.\n','attach-original-extra-b');
    await f.engine.run('phase.publish',{phaseId:'intake'});await f.engine.run('phase.submit',{phaseId:'intake'});
  }
  return {...f,attach,start};
}
