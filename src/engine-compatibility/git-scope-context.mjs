/** Native scope observations; Git and presence authentication remain in their original owners. */
import {createHash} from 'node:crypto';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {evidenceGraphFromAggregate,scopeDecisionPreview} from '../evidence/graph.mjs';
import {scopeAuthorities} from '../scope/decisions.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
export function createGitScopeContextPort({root,onContext=()=>{}}) {
  return {
    async load(input) {
      const accepted=await loadAcceptedStoryExecution(root,input.workId??null),context={...accepted,
        subject:{kind:'story',id:accepted.workflow.workItem.id}};
      onContext(context);return context;
    },
    async read(context) {
      const graph=await evidenceGraphFromAggregate(root,context.definition,context.workflow),
        preview=await scopeDecisionPreview(root,context.definition,context.workflow);
      graph.scopePreview=preview;context.graph=graph;
      const inventory=preview.previewed&&preview.inventory?preview.inventory:graph.scope;
      if(!inventory)throw new SingularityFlowError(graph.findings.find(row=>row.code==='SCOPE_INVENTORY_UNAVAILABLE')?.message
        ??'The scope inventory could not be read.',{code:'SCOPE_INVENTORY_UNAVAILABLE'});
      return {workId:context.workflow.workItem.id,revision:'aggregate-'+createHash('sha256').update(canonicalJson(context.workflow)).digest('hex'),
        inventory,knownClauseIds:[...new Set([...(graph.records.indexes??[]).flatMap(index=>index.clauses??[]).map(row=>row.id),...preview.clauseIds])].sort(),
        authorities:scopeAuthorities(context.workflow),completenessReview:graph.completenessReview??null};
    }
  };
}
