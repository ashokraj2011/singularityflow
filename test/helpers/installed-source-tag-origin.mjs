/** Installed value replay with original native outcomes and explicit host-supplied facts. */
import assert from 'node:assert/strict';import path from 'node:path';import {registerHooks} from 'node:module';
const oracle=JSON.parse('__ORIGIN_ORACLE__'),unexpected=[],hook=registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('node:')){unexpected.push(specifier);throw Error('Unexpected provenance infrastructure: '+specifier);}return next(specifier,context);
}});
const pure=await import('@sdk-name@/specifications'),paths=Object.freeze({profile:pure.CONFIGURATION_PATH_SYNTAX_V2,grammar:path.sep==='\\'?'win32':'posix',
  isAbsolute:path.isAbsolute,normalize:path.normalize,parse:path.parse,posixIsAbsolute:path.posix.isAbsolute,posixNormalize:path.posix.normalize,
  posixBasename:path.posix.basename,posixDirname:path.posix.dirname,posixRelative:path.posix.relative,win32IsAbsolute:path.win32.isAbsolute,toPosix:value=>value.split(path.sep).join('/')}),
  values=pure.sourceTagOriginPolicies(paths,[]);
assert.equal(values.profile,'sflow-source-tag-origin-values/v1');assert.match(oracle.nativeCommit,/^301c382c3/u);assert.equal(oracle.cases.length,34);
const errorValue=error=>({name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode});
function replay(api,row,name) {
  const source=row.input,carried={baseline:source.changeSet?.base?.commit??null,changes:(source.changeSet?.entries??[]).map(entry=>({oldPath:entry.oldPath??null,
    newPath:entry.newPath??null,previousRegular:/^100/u.test(entry.oldMode??'')})),occurrences:source.occurrences,tag:source.tag},
    added={baseline:source.workflow.workIntervals?.history?.[0]?.sourceBaseCommit??source.workflow.workIntervals?.current?.sourceBaseCommit,
      occurrences:source.occurrences,tag:source.tag,pathContext:source.pathContext},
    run=(name==='carried'?api.carriedTagIdsReplay:api.storyTagLinesReplay)(name==='carried'?carried:added);let cursor=0,outcome;
  try {
    let step=run.next();while(!step.done) {
      const request=step.value,saved=row.traces[name][cursor++];assert.ok(saved);assert.ok(Object.isFrozen(request));let value;
      if(request.kind==='origin-baseline-texts'){assert.equal(saved.name,'baseline-texts');assert.deepEqual(saved.args[0],request.paths.map(path=>({key:path,ref:request.baseline,path})));value=new Map(saved.value??[]);}
      else if(request.kind==='origin-comment-tags'){assert.equal(saved.name,'comment-tags');assert.deepEqual(saved.args,[request.source,{sourcePath:request.path}]);value=saved.value;}
      else if(request.kind==='origin-line-deltas'){assert.equal(saved.name,'line-patch');assert.equal(saved.args[0],request.baseline);value=saved.value;}
      else if(request.kind==='origin-tracked-paths'){assert.equal(saved.name,'tracked-paths');assert.deepEqual(saved.args,[request.paths]);value=new Set(saved.value??[]);}
      else {assert.equal(request.kind,'origin-untracked-text');assert.equal(saved.name,'untracked-text');assert.deepEqual(saved.args,[request.path,'utf8']);value=saved.value;}
      if(saved.error)step=run.throw(Object.assign(Error(saved.error.message),saved.error));else step=run.next(value);
    }
    outcome={value:step.value===null?null:[...step.value]};
  }catch(error){if(error.code==='ERR_ASSERTION')throw error;outcome={error:errorValue(error)};}
  assert.equal(cursor,row.traces[name].length);assert.deepEqual(JSON.parse(JSON.stringify(outcome)),row.expected[name],row.id+': '+name);
}
for(const row of oracle.cases)for(const name of ['carried','added'])replay(values,row,name);
assert.deepEqual(unexpected,[]);hook.deregister();
const node=await import('@sdk-name@/specifications/node');
for(const row of oracle.cases)for(const name of ['carried','added'])replay(node,row,name);
assert.equal(node.SOURCE_TAG_ORIGIN_VALUES_PROFILE,pure.SOURCE_TAG_ORIGIN_VALUES_PROFILE);
assert.equal(Object.hasOwn(values,'publish'),false);assert.equal(Object.hasOwn(values,'approve'),false);
