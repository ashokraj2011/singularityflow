/** Reconcile a concurrent acceptance of this exact operation, without retrying admission. */
export async function prepareNamespaceOperation(committer,operationId,perform,recover,{signal}={}) {
  const accepted=await committer.inspect(operationId,{signal});
  if(accepted.status==='committed')return recover(accepted);
  try {return await perform();}
  catch(cause) {
    if(cause?.code!=='ENGINE_CONTEXT_CHANGED')throw cause;
    const concurrent=await committer.inspect(operationId,{signal});
    if(concurrent.status==='committed')return recover(concurrent);
    throw cause;
  }
}
export function commitNamespaceOperation(committer,operationId,validate,options) {
  return prepareNamespaceOperation(committer,operationId,async()=>{await validate();return committer.commit(operationId,options);},value=>value,options);
}
