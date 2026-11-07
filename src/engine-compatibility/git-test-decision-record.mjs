/** Test/evidence decision effects, through the existing native authorities and writers. */
import {actorKey} from '../state-stores.mjs';
import {loadNativeDecisionRecordContext,nativeDecisionRecordActor} from './record-decision-context.mjs';
import {resolveNativeTestDecision} from './test-decision-intent.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';

export function createGitTestDecisionRecordPort({root,interaction=null,onContext=()=>{}}) {
  const prepare=typeof interaction?.prepare==='function'?interaction.prepare.bind(interaction):null;
  return {
    async load(input,{operation}) {
      const context=await loadNativeDecisionRecordContext(root,input,operation);
      onContext(context);
      return context;
    },
    prepare:(context,request,options)=>prepare?prepare(context,request,options):request,
    async resolve(context,request,{operation}) {
      // Native command descriptions can contain omitted optional fields. Their installed record
      // encoding omits those fields; the SDK receives the same detached JSON facts, never callbacks.
      return JSON.parse(JSON.stringify(await resolveNativeTestDecision(context,request,operation.id)));
    },
    async commit(context,request,{operation}) {
      const {config,workflow}=context,identity=await nativeDecisionRecordActor(context);
      let result;
      if(operation.id==='decision.evidence-reuse') {
        const {recordEvidenceReuseDecision}=await import('./native-evidence-decisions.mjs');
        result=await recordEvidenceReuseDecision(root,config,workflow,request,identity);
      } else if(operation.id==='decision.visual-profile') {
        const {recordVisualProfileDecisionFor}=await import('./native-visual-decisions.mjs');
        result=await recordVisualProfileDecisionFor(root,config,workflow,request,identity);
      } else if(operation.id==='decision.test-narrowing') {
        const {recordTestNarrowingDecision}=await import('./native-test-narrowing-decisions.mjs');
        result=await recordTestNarrowingDecision(root,config,workflow,request,identity);
      } else if(operation.id==='decision.test-risk') {
        const {recordTestRunRiskDecision}=await import('./native-test-risk-decisions.mjs');
        result=await recordTestRunRiskDecision(root,config,workflow,request,identity);
      } else if(operation.id.startsWith('test-command.')) {
        const {recordStoryTestCommand}=await import('./native-test-command-decisions.mjs');
        result=await recordStoryTestCommand(root,config,workflow,request,identity);
      } else throw new SingularityFlowError('The test-evidence decision operation is unavailable.',{code:'ENGINE_OPERATION_UNSUPPORTED'});
      Object.assign(context,{request,result,record:result.record});
      return result.publication;
    },
    async finish(context,request,publication,{operation}) {
      return JSON.parse(JSON.stringify({workId:context.workflow.workItem.id,phase:request.phaseId,recordKind:operation.recordKind,
        record:context.record,revision:publication?.sha??null,pushed:publication?.pushed??false,
        actorId:actorKey(context.who.actor),authorityGroup:context.record.authorityGroup??null,
        currentPhase:context.workflow.currentPhase??null,
        ...(operation.allowRetained?{retained:context.result.reused===true}:{})}));
    }
  };
}
