/** Repository-qualified views of one reviewed plan. Values only; no source or authority discovery. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,REPOSITORY_PLAN_SCHEMA} from '../foundation/record-schema.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {plannedClaimSource} from './specification-values.mjs';
import {plannedClaimAllocatedTo} from './specification-policy.mjs';
import {applicationPathPolicies,supportingChangePolicies} from './source-path-policies.mjs';
export const REPOSITORY_PLAN_PROFILE='sflow-repository-plan/v1';
export const REPOSITORY_PLAN_VALUES_PROFILE='sflow-repository-plan-values/v1';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(v),maximumBytes=1_048_576;
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const fail=(message,details=null,code='SPEC_REPOSITORY_PLAN_INVALID')=>{throw new SingularityFlowError(message,{code,details});};
const cells=line=>{const text=line.trim();return text.startsWith('|')&&text.endsWith('|')?text.slice(1,-1).split('|').map(value=>value.trim()):null;};
const code=value=>/^`[^`]+`$/u.test(value)?value.slice(1,-1):value;
const order=(a,b)=>a.repositoryId<b.repositoryId?-1:a.repositoryId>b.repositoryId?1:0;
const relative=value=>{try{return sourceRelativePath(value);}catch{fail('A repository plan needs an exact relative path.',{path:value});}};
/** A local coverage view keeps globally unassigned clauses visible instead of silently excluding them. */
export function repositoryCoverageProjection(indexes,repositories){
  if(!Array.isArray(indexes)||!Array.isArray(repositories)||!repositories.length||repositories.length>32
    ||repositories.some(row=>!id(row?.id)||!Array.isArray(row.clauseIds)||row.clauseIds.some(value=>typeof value!=='string'))
    ||new Set(repositories.map(row=>row.id)).size!==repositories.length)fail('Repository coverage needs its exact clause inventory.',null,'ENGINE_REPOSITORY_COVERAGE_INVALID');
  const known=[...new Set(indexes.flatMap(index=>(index.clauses??[]).map(row=>row.id)))].sort(),all=new Set(repositories.flatMap(row=>row.clauseIds)),
    unassigned=known.filter(value=>!all.has(value)),rows=repositories.map(row=>{const owned=new Set(row.clauseIds);
      return {id:row.id,clauseIds:known.filter(value=>owned.has(value)||unassigned.includes(value))};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return rows.every(row=>row.clauseIds.length===known.length)?null:{profile:'sflow-namespace-repository-coverage/v1',repositories:rows};
}
function rootsValue(roots){
  if(!Array.isArray(roots)||!roots.length||roots.length>32)fail('Repository roots must name between one and 32 repositories.');
  const ids=new Set(),prefixes=[];
  for(const root of roots){
    if(!exact(root,['repositoryId','pathPrefix'])||!id(root.repositoryId)||ids.has(root.repositoryId))fail('Repository roots need distinct exact repository IDs.');
    ids.add(root.repositoryId);
    if(root.pathPrefix!=='.')try{sourceRelativePath(root.pathPrefix);}catch{fail('A plan root must be an exact logical directory prefix.',{repositoryId:root.repositoryId});}
    const prefix=root.pathPrefix.toLowerCase();
    if(prefixes.some(other=>prefix==='.'||other==='.'||prefix===other||prefix.startsWith(other+'/')||other.startsWith(prefix+'/')))
      fail('Repository plan roots must not overlap, including on case-insensitive hosts.');
    prefixes.push(prefix);
  }
  return roots;
}
/** An explicit heading selects this contract. Broken declarations never fall back to legacy scope. */
function declaredRoots(markdown){
  const lines=plannedClaimSource(markdown).split(/\r?\n/u);let roots=null;
  for(let line=0;line<lines.length;line++){
    const heading=/^(#{1,6})\s+Repository roots\s*#*\s*$/iu.exec(lines[line]);if(!heading)continue;
    if(roots!==null)fail('Declare Repository roots only once.',{line:line+1});roots=[];
    const level=heading[1].length;let at=line+1;while(at<lines.length&&!lines[at].trim())at++;
    if(cells(lines[at]??'')?.map(value=>value.toLowerCase()).join('|')!=='repository|plan root'
      ||!cells(lines[at+1]??'')?.every(value=>/^:?-{3,}:?$/u.test(value))||cells(lines[at+1]).length!==2)
      fail('Repository roots needs a Repository | Plan root table.',{line:at+1});
    at+=2;
    while(at<lines.length){const row=cells(lines[at]);if(!row)break;
      if(row.length!==2)fail('Each Repository roots row needs one repository and one plan root.',{line:at+1});
      roots.push({repositoryId:code(row[0]),pathPrefix:code(row[1])});at++;
    }
    for(;at<lines.length&&!new RegExp('^#{1,'+level+'}\\s','u').test(lines[at]);at++)if(lines[at].trim())
      fail('Repository roots must contain exactly its declared table.',{line:at+1});
    line=at-1;
  }
  return roots===null?null:rootsValue(roots).map(root=>({...root})).sort(order);
}
export function repositoryPlanPolicies(pathSyntax,applicationRoots){
  const {isApplicationPath,applicationPathContext}=applicationPathPolicies(applicationRoots),{classifySupportingChange}=supportingChangePolicies(pathSyntax);
  const selected=(path,context)=>isApplicationPath(path,context);
  function locate(path,roots,context){
    relative(path);
    const found=roots.find(root=>root.pathPrefix==='.'||path.startsWith(root.pathPrefix+'/'));
    if(!found){if(!selected(path,context))return null;
      fail('Every application and test path must belong to a declared repository root.',{path});}
    // The single-root form still leaves global Story evidence in its original namespace.
    if(found.pathPrefix==='.'&&!selected(path,context))return null;
    const local=found.pathPrefix==='.'?path:path.slice(found.pathPrefix.length+1);relative(local);
    if(!selected(path,context)||!selected(local,context))fail('A repository prefix cannot turn private Story data into application scope.',{path});
    return {repositoryId:found.repositoryId,path:local};
  }
  function deriveRepositoryPlan(markdown,planned,{definition={},workflow={}}={}){
    const roots=declaredRoots(markdown);if(roots===null)return null;
    if(!plain(planned?.claims))fail('Repository roots require the normalized reviewed plan.');
    const context=applicationPathContext(definition,workflow.resolution??workflow),repositories=roots.map(root=>({id:root.repositoryId,claims:{},supportingFiles:[],supportingFileDetails:[]})),
      byId=new Map(repositories.map(row=>[row.id,row])),used=new Set();
    const local=path=>{const value=locate(path,roots,context);if(value)used.add(value.repositoryId);return value;};
    for(const [clauseId,claim]of Object.entries(planned.claims)){
      if(!Array.isArray(claim.expectedPaths)||!Array.isArray(claim.tests))fail('Repository allocation requires exact planned path lists.');
      const expected=claim.expectedPaths.map(path=>({path,value:local(path)})),tests=claim.tests.map(path=>({path,value:local(path)}));
      if(expected.some(item=>!item.value)&&!['evidence','document'].includes(claim.fulfillment))
        fail('Source and configuration obligations must name paths in a declared repository.',{clauseId});
      if(tests.some(item=>!item.value))fail('Executable tests must belong to a repository.',{clauseId});
      for(const row of repositories){const expectedPaths=expected.filter(item=>item.value?.repositoryId===row.id).map(item=>item.value.path),
          testPaths=tests.filter(item=>item.value?.repositoryId===row.id).map(item=>item.value.path);
        if(expectedPaths.length||testPaths.length)row.claims[clauseId]={...structuredClone(claim),expectedPaths,tests:testPaths};}
    }
    for(const path of planned.supportingFiles??[]){const value=local(path);if(!value)fail('Supporting files must belong to a repository.',{path});
      const row=byId.get(value.repositoryId),detail=(planned.supportingFileDetails??[]).find(item=>item.path===path),classification=classifySupportingChange(value.path);
      if(classification.refused)fail('A supporting path is not supporting configuration or documentation in its own repository.',{path});
      row.supportingFiles.push(value.path);if(detail)row.supportingFileDetails.push({path:value.path,class:classification.class,reason:detail.reason});}
    // Stated test contracts are global obligations. Resolve their paths without shrinking their combination.
    for(const contract of planned.verificationContracts??[])for(const slot of contract.slots??[])if(slot.method==='test'){
      for(const path of slot.witness?.path?[slot.witness.path]:slot.witness?.paths??[])if(!local(path))fail('Test witnesses must belong to a repository.',{clauseId:contract.clauseId});}
    const unused=roots.filter(root=>!used.has(root.repositoryId)).map(root=>root.repositoryId);
    if(unused.length)fail('Repository roots includes repositories with no planned files.',{repositories:unused});
    const result={schemaVersion:REPOSITORY_PLAN_SCHEMA.currentVersion,format:REPOSITORY_PLAN_PROFILE,roots,repositories};
    if(new TextEncoder().encode(canonicalJson(result)).byteLength>maximumBytes)fail('The repository plan exceeds its bounded record size.',null,'SPEC_REPOSITORY_PLAN_LIMIT');
    return result;
  }
  function repositoryPlanValue(value){
    try{admitRecordSchemaVersion(REPOSITORY_PLAN_SCHEMA,value);}catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
      code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'SPEC_REPOSITORY_PLAN_INVALID'});}
    if(!exact(value,['schemaVersion','format','roots','repositories'])||value.format!==REPOSITORY_PLAN_PROFILE)fail('The repository plan has another format.');
    rootsValue(value.roots);
    if(!Array.isArray(value.repositories)||value.repositories.length!==value.roots.length)fail('The repository plan lost its exact repository set.');
    for(const [index,row]of value.repositories.entries()){
      if(!exact(row,['id','claims','supportingFiles','supportingFileDetails'])||row.id!==value.roots[index].repositoryId||!plain(row.claims)
        ||!Array.isArray(row.supportingFiles)||!Array.isArray(row.supportingFileDetails))fail('The repository projection has another shape.');
      for(const claim of Object.values(row.claims))if(!plain(claim)||!Array.isArray(claim.expectedPaths)||!Array.isArray(claim.tests)
        ||Object.keys(claim).some(key=>!['expectedPaths','tests','testDisposition','testReason','verificationCriterion','deviation','fulfillment','steps','observableResult'].includes(key))
        ||claim.steps!==undefined&&(!Array.isArray(claim.steps)||claim.steps.some(step=>!id(step))||new Set(claim.steps).size!==claim.steps.length))
        fail('The repository projection has another claim shape.');
      for(const path of [...row.supportingFiles,...Object.values(row.claims).flatMap(claim=>[...claim.expectedPaths,...claim.tests])])relative(path);
      if(new Set(row.supportingFiles).size!==row.supportingFiles.length||new Set(row.supportingFileDetails.map(detail=>detail?.path)).size!==row.supportingFileDetails.length)
        fail('The repository projection repeats a supporting file.');
      for(const detail of row.supportingFileDetails)if(!exact(detail,['path','class','reason'])||!row.supportingFiles.includes(detail.path)||classifySupportingChange(detail.path).class!==detail.class
        ||typeof detail.class!=='string'||typeof detail.reason!=='string'||!detail.reason||detail.reason.length>500)fail('The repository projection has another supporting file.');
    }
    if(new TextEncoder().encode(canonicalJson(value)).byteLength>maximumBytes)fail('The repository plan exceeds its bound.',null,'SPEC_REPOSITORY_PLAN_LIMIT');return value;
  }
  function repositoryPlanProjection(value,repositoryId){
    repositoryPlanValue(value);const row=value.repositories.find(item=>item.id===repositoryId);
    if(!row)fail('The selected repository is absent from the reviewed Repository roots.',{repositoryId},'SPEC_REPOSITORY_BINDING_REQUIRED');
    return row;
  }
  function assertRepositoryPlanSources(value,phaseId,repositories){
    if(value===null)return;repositoryPlanValue(value);
    if(!id(phaseId)||!Array.isArray(repositories)||repositories.length>32||repositories.some(value=>!id(value))||new Set(repositories).size!==repositories.length)
      fail('Repository selection must contain exact distinct repository identities.');
    const selected=new Set(repositories),required=value.repositories.filter(row=>row.supportingFiles.length||Object.values(row.claims).some(claim=>plannedClaimAllocatedTo(claim,phaseId))).map(row=>row.id),
      missing=required.filter(id=>!selected.has(id)),unknown=repositories.filter(id=>!value.roots.some(root=>root.repositoryId===id));
    if(missing.length||unknown.length)fail('Bind the reviewed repositories before opening this code generation.',{phase:phaseId,missing,unknown,required,
      operation:'source.bind',requires:['operationId','expectedRevision','reason'],repositories:[...new Set([...required,...repositories.filter(id=>!unknown.includes(id))])].sort()},'SPEC_REPOSITORY_BINDING_REQUIRED');
  }
  function repositoryPlanTestLocation(value,path,{definition={},workflow={}}={}){
    repositoryPlanValue(value);return locate(path,value.roots,applicationPathContext(definition,workflow.resolution??workflow));
  }
  /** A reviewed additive accounting record keeps each path in its original repository. */
  function repositoryPlanAmendmentProjection(value,record,repositoryId,options={}){
    repositoryPlanProjection(value,repositoryId);
    if(!record)return null;
    if(record.kind!=='planned'||record.amendment!==true||!plain(record.claims)||Object.keys(record.claims).length)fail('Repository accounting projects only additive reviewed plan records.');
    if(!plain(record.accountedPaths)||Object.values(record.accountedPaths).some(paths=>!Array.isArray(paths))
      ||!Array.isArray(record.supportingFileDetails??[]))fail('Repository accounting needs exact path lists and supporting-file details.');
    const local=path=>{const location=repositoryPlanTestLocation(value,path,options);return location?.repositoryId===repositoryId?location.path:null;},
      accountedPaths=Object.fromEntries(Object.entries(record.accountedPaths??{}).map(([id,paths])=>[id,paths.map(local).filter(Boolean)]).filter(([,paths])=>paths.length)),
      details=(record.supportingFileDetails??[]).map(row=>({...row,path:local(row.path)})).filter(row=>row.path);
    if(!Object.keys(accountedPaths).length&&!details.length)return null;
    return {...record,accountedPaths,supportingFiles:details.map(row=>row.path),supportingFileDetails:details};
  }
  return Object.freeze({profile:REPOSITORY_PLAN_VALUES_PROFILE,deriveRepositoryPlan,repositoryPlanValue,repositoryPlanProjection,assertRepositoryPlanSources,repositoryPlanTestLocation,repositoryPlanAmendmentProjection});
}
