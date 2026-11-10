/** Story-local command changes. Original repository commands stay immutable; human receipts own overlays. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_STORY_COMMAND_SCHEMAS,namespaceStoryCommandRecordProfile} from '../foundation/record-schema.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {storyTestCommandPolicies} from '../kernel/test-recovery.mjs';
import {standaloneDecisionRequest,standaloneDecisionAdmission} from '../kernel/decision-plan.mjs';
import {testRunRiskAuthorities,testCommandDecisionPhase,phaseCorrectionTargets} from '../kernel/approval-fallback.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {normalizeExternalCommand} from '../engine-compatibility/node-configuration-path.mjs';
import {exactObject} from '../sda/namespace/values.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
const rules=storyTestCommandPolicies(NODE_TEXT_DIGESTS),same=(a,b)=>canonicalJson(a)===canonicalJson(b),
  hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export const NAMESPACE_STORY_COMMAND_PROFILE='sflow-namespace-story-command/v1';
export const NAMESPACE_COMMAND_REPLACEMENT_PROFILE='sflow-namespace-command-replacement/v1';
const operations=['test-command.request','test-command.decide'];
/** Only exact acknowledged deltas may replace a configured command; revocation restores its original form. */
export function createNamespaceTestCommandOwners({observer,scope,workId}){
  const owners=new Map(),readers=new Map();
  async function admitted(snapshot,{signal,policyTraversal}={}){
    const rows=snapshot.workflow.testCommandDecisions??[],links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>operations.includes(row.operation));
    if(!Array.isArray(rows))fail('The Story-command inventory is invalid.');
    if(!links.length){if(rows.length||Object.values(snapshot.workflow.phases).some(phase=>phase.storyTestCommands?.length))fail('Story test commands need their accepted original records.');return [];}
    const references=links.map(link=>link.record),last=await readers.get(links.at(-1).operation).accepted(links.at(-1),{signal,policyTraversal});
    if(!same(rows,last.accepted.state.workflow.testCommandDecisions??[]))fail('The Story-command inventory differs from its accepted transition.');
    rules.assertStoryTestCommands(snapshot.workflow);return references;
  }
  function projected(workflow,phaseId){
    const original=(workflow.phases[phaseId]?.qualityCommands??[]).map(normalizeExternalCommand),commands=new Map(original.map(value=>[value.id,value]));
    if(commands.size!==original.length)fail('Configured check IDs must be unique.','ENGINE_INPUT_INVALID');
    for(const row of workflow.testCommandDecisions??[]){if(!row.accepts||row.phase!==phaseId)continue;
      const {request,state}=rules.storyTestCommandState(workflow,row.accepts);
      if(state!=='accepted')continue;
      const current=commands.get(request.command.id),replacement=request.repin;
      if(replacement){const profile=namespaceStoryCommandRecordProfile('replacement',replacement);exactObject(replacement,['schemaVersion','format','beforeSha256']);
        if(replacement.format!==profile.format||!current||hash(current)!==replacement.beforeSha256)fail('An accepted command replacement lost its exact predecessor.');}
      else if(current)fail('An additive Story command cannot replace a configured command.');
      commands.set(request.command.id,normalizeExternalCommand(request.command));
    }
    return [...commands.values()];
  }
  async function commands(snapshot,phaseId,options={}){
    const references=await admitted(snapshot,options),value=projected(snapshot.workflow,phaseId);
    return {commands:value,identity:{profile:NAMESPACE_STORY_COMMAND_PROFILE,phaseId,
      baseSha256:hash(snapshot.workflow.phases[phaseId]?.qualityCommands??[]),receipts:namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>operations.includes(row.operation)),commandsSha256:hash(value)},references};
  }
  for(const operation of operations){const owner={
    agentPhase:snapshot=>snapshot.workflow.currentPhase,
    async read(snapshot,request,options={}){
      const current=await commands(snapshot,request.phaseId,options),phase=snapshot.workflow.phases[request.phaseId];
      if(!phase)fail('The command target is not in this Story.','TEST_COMMAND_DECISION_INVALID');
      if(phase.status==='awaiting_approval')fail('Return the exact submitted phase through its authorized reviewer before changing its test commands.','TEST_COMMAND_DECISION_DURING_REVIEW',{
        workId,phase:phase.id,actions:[{operation:'phase.review',inputs:{workId,phaseId:phase.id}},...(snapshot.workflow.currentPhase===phase.id?phaseCorrectionTargets(phase).map(target=>({operation:'phase.reject',
          inputs:{workId,phaseId:phase.id,target},requiredInputs:['confirm','reason'],prerequisites:['authorized-human-reviewer']})):[])]});
      let command=null,repin=null;
      if(operation==='test-command.request'){
        if(request.suggestionId||request.repinId||request.sourceRoots?.length)fail('Supply the explicit namespace Story command and its exact optional replacement.','TEST_COMMAND_DECISION_INVALID');
        const wrapper=request.command;
        try{exactObject(wrapper,['profile','command','replaces']);if(wrapper.profile!==NAMESPACE_STORY_COMMAND_PROFILE)throw Error('Another profile.');
          command=normalizeExternalCommand(wrapper.command);
          if(command.kind!=='test'||command.requirement!=='required'||command.modelPolicy!=='never'||!command.argv||command.command||!command.result)throw Error('Use structured, model-free tests.');
          const original=current.commands.find(row=>row.id===command.id);
          if(wrapper.replaces!==null){exactObject(wrapper.replaces,['id','sha256']);if(wrapper.replaces.id!==command.id||!original||original.kind!=='test'||wrapper.replaces.sha256!=='sha256:'+hash(original))throw Error('The predecessor differs.');
            const profile=namespaceStoryCommandRecordProfile('replacement',{schemaVersion:NAMESPACE_STORY_COMMAND_SCHEMAS.replacement.currentVersion});
            repin={schemaVersion:profile.version,format:profile.format,beforeSha256:hash(original)};}
          else if(original)throw Error('An existing command needs an explicit replacement binding.');
        }catch(cause){fail('Review the exact current command before requesting its structured replacement.','TEST_COMMAND_DECISION_INVALID',{
          commands:current.commands.map(row=>({id:row.id,sha256:'sha256:'+hash(row)})),profile:NAMESPACE_STORY_COMMAND_PROFILE,cause:cause.message});}
      }else if(!rules.storyTestCommandState(snapshot.workflow,request.accept??request.revoke))fail('The Story has no such command request.','TEST_COMMAND_DECISION_UNKNOWN');
      return {generation:phase.generation,identity:{profile:NAMESPACE_STORY_COMMAND_PROFILE,commands:current.identity,command,repin},command,repin,references:current.references};
    },
    authority(workflow,request,actor){if(operation==='test-command.request')return null;
      const required=[...(workflow.resolution.presence?['person-presence']:[]),...(workflow.resolution.testRecovery?.enabled?['test-recovery-command-agreement']:[])];
      if(required.length)fail('This command decision requires its actual additional evidence and authority owners.','ENGINE_PORT_UNAVAILABLE',{required});
      const groups=testRunRiskAuthorities(workflow,request.phaseId);if(!groups.length)fail('No configured group can decide this phase\'s test commands.','RISK_AUTHORITY_UNAVAILABLE');
      return requireApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},actor.identity).authorityGroup;},
    plan(workflow,request,facts,source){standaloneDecisionAdmission(operation,workflow);const proposed=structuredClone(workflow),common={actor:facts.actorId,at:facts.at},
      record=operation==='test-command.request'?rules.recordStoryTestCommandRequest(proposed,{phaseId:request.phaseId,command:source.command,repin:source.repin,reason:request.reason,...common})
        :rules.recordStoryTestCommandDecision(proposed,{id:request.accept??request.revoke,outcome:request.accept?'accept':'revoke',reason:request.reason,...common,
          authorityGroup:facts.authorityGroup,identityAssurance:null,selfApproval:workflow.phases[testCommandDecisionPhase(workflow,request.phaseId)]?.approvalPolicy.allowSelfApproval!==false});
      projected(proposed,request.phaseId);
      proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'test_command_decided',phase:request.phaseId,
        detail:operation==='test-command.request'?record.id+' requests '+record.command.id+'. '+record.reason:(record.accepts??record.revokes)+' '+(record.accepts?'accepted':'revoked')+'. '+record.reason});
      return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
    }};
    owners.set(operation,owner);readers.set(operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract}));
  }
  return Object.freeze({owners,readers,admitted,commands});
}
