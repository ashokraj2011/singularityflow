/** Single-record native decision port. Flags and presentation stay in the host adapter. */
import { actorKey } from '../state-stores.mjs';
import {loadNativeDecisionRecordContext,nativeDecisionRecordActor as who} from './record-decision-context.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';

export function createGitDecisionRecordPort({root, interaction=null, notice=()=>{}, onContext=()=>{}}) {
  const prepare = typeof interaction?.prepare === 'function' ? interaction.prepare.bind(interaction) : null;
  return {
    async load(input, {operation}) {
      const context = await loadNativeDecisionRecordContext(root,input,operation);
      onContext(context);
      return context;
    },
    async prepare(context, request, options) {
      // The legacy completeness adapter resolved identity before reading a checklist file.
      if (prepare && options.operation.id === 'decision.completeness') await who(context);
      return prepare ? prepare(context, request, options) : request;
    },
    async commit(context, request, {operation}) {
      const {config, workflow} = context;
      const identity = await who(context);
      let result, record;
      if (operation.id === 'decision.risk') {
        const {commitRiskDecision} = await import('./native-obligation-risk.mjs');
        result = await commitRiskDecision(root, config, workflow, request, identity);
        record = result.record;
      } else {
        const owners = await import('./native-story-decisions.mjs');
        if (operation.id === 'decision.scope') {
          result = await owners.commitScopeDecision(root, config, workflow, request, identity);
          record = result.decision;
        } else if (operation.id === 'decision.applicability') {
          result = await owners.commitApplicabilityDecision(root, config, workflow, request, identity);
          record = result.decision;
        } else if (operation.id === 'decision.completeness') {
          result = await owners.commitCompletenessReview(root, config, workflow, request, identity);
          record = result.review;
        } else if (operation.id === 'decision.choose') {
          result = await owners.commitRoutingChoice(root, config, workflow,
            {...request, expected:request.expected ?? context.pending.key}, {...identity, notice});
          record = result.result.outcome;
        } else throw new SingularityFlowError('The standalone decision operation is unavailable.', {code:'ENGINE_OPERATION_UNSUPPORTED'});
      }
      Object.assign(context, {request, result, record});
      return result.publication;
    },
    async finish(context, request, publication, {operation}) {
      return JSON.parse(JSON.stringify({workId:context.workflow.workItem.id, phase:context.phaseId, recordKind:operation.recordKind,
        record:context.record, revision:publication.sha, pushed:publication.pushed,
        actorId:actorKey(context.who.actor),
        authorityGroup:context.record.authorityGroup ?? context.result.authority?.authorityGroup ?? null,
        currentPhase:context.workflow.currentPhase ?? null}));
    }
  };
}
