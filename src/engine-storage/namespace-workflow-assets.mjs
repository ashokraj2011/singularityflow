/** Names only, over the actual approved dependency closure. No file discovery or writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {namespaceWorkflowAssetBundle} from '../kernel/namespace-workflow-assets.mjs';
import {summarizeWorkflowAssets,workflowAssetInventory} from '../kernel/workflow-assets.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
export function createNamespaceWorkflowAssetsPort(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),contexts=new WeakMap();
  async function principal(signal,expected=null){return phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation:'workflow.assets',signal}),
    scope.projectId,'workflow.assets',{expected});}
  return {
    async load(input,{signal}={}){
      const identity=await principal(signal),snapshot=(await observer.inspect({signal})).snapshot,
        approved=await observer.approved(snapshot,{signal}),bundle=namespaceWorkflowAssetBundle(approved.compiled,input.workflowIds),
        digest=createHash('sha256').update(canonicalJson({format:'sflow-namespace-workflow-assets/v1',configuration:snapshot.configuration,
          workflows:bundle.workflows.map(({id})=>approved.compiled.workflows[id]),bundle})).digest('hex'),
        context={selection:{workflows:bundle.workflows,bundleSha256:'sha256:'+digest,source:{kind:'approved-snapshot',revision:snapshot.configuration.content.sha256}}};
      contexts.set(context,{snapshot,identity,bundle});return context;
    },
    async read(context,_selection,{signal}={}){
      const value=contexts.get(context);if(!value)throw new SingularityFlowError('Use the issued workflow inventory.',{code:'ENGINE_INPUT_INVALID'});
      await principal(signal,value.identity);if((await observer.inspect({signal})).snapshot.revision!==value.snapshot.revision)throw new SingularityFlowError(
        'The Story changed during its workflow inventory read.',{code:'ENGINE_CONTEXT_CHANGED'});
      return {bundleSha256:context.selection.bundleSha256,dependencies:workflowAssetInventory(value.bundle),summary:summarizeWorkflowAssets(value.bundle)};
    }
  };
}
