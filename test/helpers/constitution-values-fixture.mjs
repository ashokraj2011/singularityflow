/** Replay the independent pre-extraction constitution capture without creating new inputs. */
export function constitutionValueOutcome(api,input){try{let value;
  if(input.method==='parse')value=api.parseConstitution(input.markdown,input.options);
  else if(input.method==='generate')value=api.generateConstitution(input.markdown,input.resolution);
  else if(input.method==='index'){const parsed=api.parseConstitution(input.markdown,{resolution:input.resolution});value=api.constitutionIndex({articles:parsed.articles,path:input.path,fileSha256:input.fileSha256,configurationCommit:input.configurationCommit,resolution:input.resolution});}
  else if(input.method==='pin'){const constitution=api.parseConstitution(input.markdown,{resolution:input.resolution}),index=api.constitutionIndex({articles:constitution.articles,path:input.path,fileSha256:input.fileSha256,configurationCommit:input.configurationCommit,resolution:input.resolution});
    value=api.constitutionPin({constitution:{...constitution,path:input.path,fileSha256:input.fileSha256},index,configurationCommit:input.configurationCommit,resolution:input.resolution});}
  else if(input.method==='citations')value=api.validateCitations(input.pin,api.citedArticleIds(input.markdown),input.options);
  else if(input.method==='required')value=api.requiredArticles(input.pin,input.ids);
  else if(input.method==='exception')value=api.buildConstitutionException(input.value);
  else if(input.method==='expired')value=api.expiredExceptions(input.values,input.at);
  else throw Error('Unknown constitution capture operation.');
  return {status:'returned',value:JSON.parse(JSON.stringify(value))};
}catch(error){return {status:'threw',name:error.name,message:error.message,code:error.code??null,details:error.details??null};}}
