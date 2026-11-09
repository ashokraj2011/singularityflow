/** Original native outcomes, recorded before separating policy from Git and file reads. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {sourceTagOriginPolicies,SOURCE_TAG_ORIGIN_VALUES_PROFILE} from '../src/kernel/code-delivery-evidence.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {GOVERNED_ROOTS} from '../src/governed-roots.mjs';
import {gitTagLineDeltas} from '../src/git-status-detail.mjs';
import {plannedSourceClauseBindings} from '../src/delivery-evidence.mjs';
import * as node from '../src/engine-compatibility/node-source-policy.mjs';
import {sourceTagOriginCases,sourceTagOriginFixture} from './helpers/source-tag-origin-fixture.mjs';
const oracle=JSON.parse(await readFile(new URL('./fixtures/source-tag-origin/native-v1.json',import.meta.url),'utf8')),
  values=sourceTagOriginPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS),
  clean=(value,root='')=>JSON.parse(root?JSON.stringify(value).split(root).join('<checkout>'):JSON.stringify(value)),
  errorValue=error=>({name:error.name,message:error.message,code:error.code,details:error.details,exitCode:error.exitCode});
const facts=row=>({baseline:row.input.changeSet?.base?.commit??null,changes:(row.input.changeSet?.entries??[]).map(entry=>({
  oldPath:entry.oldPath??null,newPath:entry.newPath??null,previousRegular:/^100/u.test(entry.oldMode??'')})),occurrences:row.input.occurrences,tag:row.input.tag});
function replay(api,row,name) {
  const input=name==='carried'?facts(row):{baseline:row.input.workflow.workIntervals?.history?.[0]?.sourceBaseCommit??row.input.workflow.workIntervals?.current?.sourceBaseCommit,
    occurrences:row.input.occurrences,tag:row.input.tag,pathContext:row.input.pathContext},
    run=(name==='carried'?api.carriedTagIdsReplay:api.storyTagLinesReplay)(input),trace=row.traces[name];let cursor=0,outcome;
  try {
    let step=run.next();while(!step.done) {
      const request=step.value,saved=trace[cursor++];assert.ok(saved,row.id+': unexpected '+request.kind);assert.ok(Object.isFrozen(request));let value;
      switch(request.kind) {
        case 'origin-baseline-texts':{
          assert.equal(saved.name,'baseline-texts');const [files,limits]=saved.args;
          assert.deepEqual(files,request.paths.map(path=>({key:path,ref:request.baseline,path})));
          assert.deepEqual(limits,{maximumObjectBytes:request.maximumObjectBytes,maximumBytes:request.maximumBytes});
          value=saved.value&&new Map(saved.value.map(([path,bytes])=>[path,Buffer.from(bytes,'base64').toString('utf8')]));break;
        }
        case 'origin-comment-tags':assert.equal(saved.name,'comment-tags');assert.deepEqual(saved.args,[request.source,{sourcePath:request.path}]);value=saved.value;break;
        case 'origin-line-deltas':assert.equal(saved.name,'line-patch');assert.deepEqual(saved.args,[request.baseline,request.tag==='clause'?'@[Cc][Ll][Aa][Uu][Ss][Ee]':'@[Aa][Cc]']);value=saved.value&&gitTagLineDeltas(saved.value);break;
        case 'origin-tracked-paths':assert.equal(saved.name,'tracked-paths');assert.deepEqual(saved.args,[request.paths]);value=saved.value&&new Set(saved.value);break;
        case 'origin-untracked-text':assert.equal(saved.name,'untracked-text');assert.deepEqual(saved.args,[request.path,'utf8']);value=saved.value;break;
        default:assert.fail(request.kind);
      }
      if(saved.error)step=run.throw(Object.assign(Error(saved.error.message),saved.error));else step=run.next(value);
    }
    outcome={value:step.value===null?null:[...step.value]};
  }catch(error){if(error.code==='ERR_ASSERTION')throw error;outcome={error:errorValue(error)};}
  assert.equal(cursor,trace.length,row.id+': consume every original observation');assert.deepEqual(clean(outcome),row.expected[name],row.id+': '+name);return outcome;
}
test('the oracle comes from the original native line and baseline helpers before extraction',()=>{
  assert.match(oracle.nativeCommit,/^301c382c3/u);assert.equal(oracle.cases.length,34);assert.equal(values.profile,SOURCE_TAG_ORIGIN_VALUES_PROFILE);
  assert.equal(oracle.helpers.carriedTags,'d1f90ede15ee82676e4dd38204f9fd6a68fa3a01dffe63a897860eff9fcfbc33');
  assert.equal(oracle.helpers.storyAddedTagLines,'8bde3c4ac1fcf92f04fed902832625d6b979203c31c659888547ef6743ca5c1c');
  assert.equal(oracle.helpers.patchHeaderPath,'c5882a6ab4b8822919316d5d349eac926aa1805578b3c8b062b3d592fac8bbe9');
});
for(const row of oracle.cases)test('native source-tag origin: '+row.id,async t=>{
  for(const name of ['carried','added']){replay(values,row,name);replay(node,row,name);}
  if(row.publicResult) {
    const f=await sourceTagOriginFixture(sourceTagOriginCases().find(value=>value.id===row.id));t.after(f.close);let result;
    try{result={value:await plannedSourceClauseBindings(f.root,f.config,f.workflow,f.phase,sourceTagOriginCases().find(value=>value.id===row.id).paths,{changeSet:f.changeSet})};}
    catch(error){result={error:errorValue(error)};}
    assert.deepEqual(clean(result,f.root),row.publicResult);
  }
});
test('a globally positive tag count does not claim an old untouched line, and earlier Story work differs from a later generation baseline',()=>{
  const old=oracle.cases.find(row=>row.id==='clause:old-line-remains-unowned');
  assert.deepEqual(replay(values,old,'added').value,[JSON.stringify(['src/next.js',1])]);
  const later=oracle.cases.find(row=>row.id==='clause:first-interval-before-later-baseline');
  assert.deepEqual(replay(values,later,'carried').value,['SHARED:REQ-001']);
  assert.deepEqual(replay(values,later,'added').value,[JSON.stringify(['src/app.js',1])]);
});
test('real permission and timeout failures are not interpreted as provenance, and missing references trigger no discovery',()=>{
  for(const method of ['carriedTagIdsReplay','storyTagLinesReplay']) {
    const row=oracle.cases[0],input=method==='carriedTagIdsReplay'?facts(row):{baseline:'explicit-source-reference',occurrences:row.input.occurrences,tag:'clause',pathContext:row.input.pathContext};
    for(const failure of [Object.assign(Error('The original source is not readable.'),{code:'EACCES'}),Object.assign(Error('Original source observation timed out.'),{code:'ETIMEDOUT',timeoutMs:300000})]) {
      const run=values[method](input);assert.equal(run.next().done,false);assert.throws(()=>run.throw(failure),error=>error===failure);
    }
    const noSource=values[method]({...input,baseline:null});assert.deepEqual(noSource.next(),{value:method==='carriedTagIdsReplay'?new Set():null,done:true});
  }
});
