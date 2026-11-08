/** Empty real stores and one public Engine; every lifecycle effect uses the registry. */
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {namespaceConfigurationFixture} from './namespace-configuration-fixture.mjs';
import {createFilesystemNamespaceStore} from '../../src/sda/filesystem-namespace-adapter.mjs';
import {openNativeSqliteDatabase} from '../../src/sda/sqlite-native.mjs';
import {createSqliteContentStore} from '../../src/sda/sqlite-content-adapter.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceLifecycleObserver} from '../../src/engine-storage/namespace-lifecycle-reader.mjs';
export async function namespaceEngineFixture(t,{backend='filesystem',working=true,configure=null}={}) {
  const f=await namespaceConfigurationFixture(t,{backend,enroll:false}),workId='composed-story';
  const source=structuredClone(f.source);
  source.definition.approvalAuthorities={reviewers:{members:[{email:'reviewer@example.test'}]}};
  source.definition.phases.intake.approval={authorities:['reviewers'],minimum:1,rejectTo:['intake'],allowSelfApproval:false};
  source.definition.workTypes.simple.omits=['scope','plan','implement','verify'].map(responsibility=>({responsibility,
    reason:'This workflow retains a reviewed document without delivering application behavior.',authority:'reviewers'}));
  if(configure)configure(source);
  if(!source.definition.approvalAuthorities.reviewers.members.some(member=>member.email==='independent@example.test')) {
    source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'});
  }
  let local=null;
  if(working) {
    const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-composed-working-')),binding={kind:'machine-local',deviceId:'composed-device'};
    const records=await createFilesystemNamespaceStore({root:path.join(directory,'records'),binding,create:true});
    const database=await openNativeSqliteDatabase(path.join(directory,'content.db')),content=createSqliteContentStore({database,binding,create:true});
    local={records,content};t.after(async()=>{database.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  }
  Object.assign(f.control,{engineCalls:0,engineHook:()=>{},principalId:'author',agentId:'analyst',actorKind:'human',
    identity:{name:'Example reviewer',email:'reviewer@example.test',login:null},
    permissions:['project.enroll','configuration.approve','story.create','source.bind','phase.prepare','phase.draft.read',
      'phase.draft.write','phase.draft.rebase','phase.publish','phase.submit','phase.approve','decision.choose']});
  const access={async current(request){f.control.engineCalls++;await f.control.engineHook(f.control.engineCalls,request);
    return {projectId:f.scope.projectId,principalId:f.control.principalId,actorKind:f.control.actorKind,agentId:f.control.agentId,
      identity:structuredClone(f.control.identity),permissions:[...f.control.permissions]};}};
  const options={records:f.records,content:f.content,scope:f.scope,workId,authority:f.authority,access,clock:f.clock,working:local};
  const make=extra=>createNamespaceEngine({...options,...extra}),engine=make();
  function asAuthor(){Object.assign(f.control,{principalId:'author',agentId:'analyst',identity:{name:'Example reviewer',email:'reviewer@example.test',login:null}});}
  function asReviewer(){Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,identity:{name:'Independent reviewer',email:'independent@example.test',login:null}});}
  async function bootstrap() {
    const enrolled=await engine.run('project.enroll',{operationId:'enroll-composed'});
    const reference=await f.store(source),configurationInput={operationId:'approve-composed',source:reference,expectedRevision:null,
      confirm:reference.sha256,reason:'The human reviewed the complete workflow package.'};
    const configured=await engine.run('configuration.approve',configurationInput);
    const retained=(await f.content.put(f.scope,'state',Buffer.from('# Request\n\nRetain an observable reviewed document.\n'))).reference;
    const creationInput={operationId:'create-composed',workId,title:'Composed Story',workTypeId:'simple',configurationId:'approve-composed',source:retained};
    const created=await engine.run('story.create',creationInput);
    return {enrolled,configured,created,configurationInput,creationInput};
  }
  async function author(phaseId='intake',decisionValues={}) {
    asAuthor();
    try{await engine.run('phase.prepare',{phaseId});}
    catch(error) {
      if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
      await engine.run('phase.draft.rebase',{operationId:'rebase-'+phaseId+'-'+error.details.confirm.slice(0,16),workId,phaseId,
        expectedRevision:error.details.revision,confirm:error.details.confirm,reason:'Retain the authored bytes under the actual successor basis.'});
    }
    const draft=await engine.run('phase.draft.read',{phaseId}),generation=draft.manifest.draft.generation;
    const body=(await local.content.put(f.scope,'local',Buffer.from('# Actual '+phaseId+' result\n\nGeneration '+generation+' retains observable reviewed facts.\n'))).reference;
    await engine.run('phase.draft.write',{operationId:'write-'+phaseId+'-'+generation,workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:body,reason:'Retain the complete authored document.'});
    const publication=await engine.run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'});
    const submission=await engine.run('phase.submit',{phaseId,decisionValues});return {publication,submission};
  }
  async function review(phaseId='intake') {
    asReviewer();const {manifest}=await engine.run('phase.review.resources',{phaseId});
    for(const resource of manifest.resources)await engine.run('document.read',{reference:resource.reference});
    const confirmation={workId,phase:phaseId,generation:manifest.generation,reviewPacketSha256:manifest.reviewBinding.packetSha256};
    return {confirmation,result:await engine.run('phase.approve',{phaseId,confirmation})};
  }
  const capture=async()=>(await createNamespaceLifecycleObserver(options).capture()).snapshot;
  return {...f,workId,source,local,options,access,engine,make,bootstrap,author,review,asAuthor,asReviewer,capture};
}
