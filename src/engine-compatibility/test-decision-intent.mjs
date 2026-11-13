/** Resolve private retained records and repository facts. Never executes a test or records a decision. */
import {resolveTestEvidenceIntent} from '../kernel/decision-plan.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';

const fail=message=>{throw new SingularityFlowError(message,{code:'TEST_COMMAND_DECISION_INVALID'});};

async function testCommandIntent(context,request,operation) {
  const {root,config,workflow}=context;
  if(operation==='test-command.decide') {
    const {storyTestCommandState}=await import('../story-test-commands.mjs');
    const id=request.accept??request.revoke;
    const target=storyTestCommandState(workflow,id)?.request;
    if(!target)throw new SingularityFlowError(`This Story has no test command request ${id}.`,{code:'TEST_COMMAND_DECISION_UNKNOWN'});
    return {...request,phaseId:target.phase};
  }
  const phaseId=request.phaseId;
  let command=null,repin=null;
  if(request.repinId) {
    const [{resolveStoryLocalTestCommands},{removalRequest,repinRequest}]=await Promise.all([
      import('../local-test-runs.mjs'),import('../test-command-pins.mjs')]);
    const {phase,commands}=await resolveStoryLocalTestCommands(root,config,workflow,{phaseId});
    const current=commands.find(entry=>entry.id===request.repinId);
    const removal=current?null:await removalRequest(root,config,workflow,phase,request.repinId);
    if(!current&&!removal)fail(`Step ${phaseId} runs no test command ${request.repinId} now (it runs ${commands.map(entry=>entry.id).join(', ')||'none'}).`);
    if(removal)({repin,command}=removal);
    else {
      repin=await repinRequest(root,config,workflow,phase,current);
      command={id:current.id,kind:'test',argv:current.argv,workingDirectory:current.workingDirectory,
        affectedRoots:current.affectedRoots,...(current.ecosystem?{ecosystem:current.ecosystem}:{}),modelPolicy:'never',result:current.result};
    }
  } else {
    const [{normalizeRequiredTestCommand},{phaseRequiresCodeDelivery}]=await Promise.all([
      import('../code-delivery-tests.mjs'),import('../delivery-evidence.mjs')]);
    if(!workflow.phases?.[phaseId])fail(`Story ${workflow.workItem.id} has no step ${phaseId}.`);
    if(!phaseRequiresCodeDelivery(workflow.phases[phaseId]))fail(`Step ${phaseId} delivers no code, so it runs no test command.`);
    const {inspectedTestCommand,assertTestCommandLiterals}=await import('../test-command-selection.mjs');
    let requested=request.command;
    if(request.suggestionId)requested=await inspectedTestCommand(root,request);
    else await assertTestCommandLiterals(requested);
    try {normalizeRequiredTestCommand(requested);}
    catch(error){fail(`Test command '${requested.id}' cannot be requested: ${error.message}`);}
    command={id:requested.id,kind:'test',argv:requested.argv,...(requested.env?{env:requested.env}:{}),
      ...(requested.ecosystem?{ecosystem:requested.ecosystem}:{}),workingDirectory:requested.workingDirectory,
      affectedRoots:requested.affectedRoots,modelPolicy:'never',result:requested.result};
  }
  return {phaseId,command,repin,reason:request.reason};
}

export async function resolveNativeTestDecision(context,request,operation) {
  if(operation.startsWith('test-command.'))return testCommandIntent(context,request,operation);
  const {workflow}=context;
  let target=null,causeCategory=null;
  if(operation==='decision.evidence-reuse'&&request.revoke) {
    const {evidenceReuseDecision}=await import('../evidence-reuse.mjs');
    target=evidenceReuseDecision(workflow,request.revoke);
  } else if(operation==='decision.visual-profile'&&request.revoke) {
    const {visualProfileDecision}=await import('../visual-profile-decisions.mjs');
    target=visualProfileDecision(workflow,request.revoke);
  } else if(request.revoke) {
    const records=operation==='decision.test-narrowing'?workflow.testNarrowings:workflow.testRunRisks;
    target=(records??[]).find(entry=>!entry.revokes&&entry.id===request.revoke)??null;
  }
  if(operation==='decision.test-risk'&&request.causeClass!==null) {
    const {testRunCauseCategory}=await import('./node-test-causes.mjs');
    causeCategory=testRunCauseCategory(request.causeClass);
  }
  return resolveTestEvidenceIntent(operation,workflow,request,{target,causeCategory});
}
