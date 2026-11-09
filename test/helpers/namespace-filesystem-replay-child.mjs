/** Counts replay work and real file reads in one isolated native journal. No distribution use. */
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as transitions from '../../src/sda/namespace/state-transition.mjs';
import {namespaceLimits} from '../../src/sda/namespace/contract.mjs';
const request=JSON.parse(process.argv[2]);let applications=0,physicalReads=0,denyReads=false;
mock.module('../../src/sda/namespace/state-transition.mjs',{namedExports:{...transitions,
  applyNamespaceTransaction(...args){applications++;return transitions.applyNamespaceTransaction(...args);}}});
const {default:_default,...namedExports}=filesystem;
namedExports.open=async(file,...args)=>{
  if(denyReads&&path.basename(path.dirname(file))==='commits')throw Object.assign(new Error('Warm read denied.'),{code:'EACCES'});
  const handle=await filesystem.open(file,...args);
  return new Proxy(handle,{get(target,key){
    if(key==='readFile')return async(...values)=>{physicalReads++;return target.readFile(...values);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
};
mock.module('node:fs/promises',{namedExports});
const {openFilesystemNamespaceJournal}=await import('../../src/sda/filesystem-namespace-journal.mjs');
const limits={...namespaceLimits()};
const journal=await openFilesystemNamespaceJournal({root:request.root,binding:{kind:'shared'},limits});
const scope=request.scope,first=await journal.read(scope),coldApplications=applications;
assert.equal(coldApplications,first.sequence);
const beforeReads=physicalReads,hot=await journal.read(scope);
assert.equal(applications,coldApplications,'a verified unchanged prefix is not applied again');
assert.equal(physicalReads-beforeReads,first.sequence+1,'the manifest and every entry are physically read again');
assert.deepEqual(hot,first);
const commits=path.join(request.root,'project-'+createHash('sha256').update(JSON.stringify(scope)).digest('hex'),'commits');
const files=(await filesystem.readdir(commits)).sort(),file=path.join(commits,files[0]);
const put=(operationId,key,value)=>({operationId,preconditions:[{namespace:'state',key,version:null}],
  changes:[{op:'put',namespace:'state',key,value,immutable:false}],events:[]});
if(request.mode==='reuse'){
  first.state.records.values().next().value.value.nested.retained=false;
  first.state.records.clear();assert.deepEqual(await journal.read(scope),hot,'the caller cannot poison memoized Maps or nested record values');
  const written=await journal.append(scope,hot,put('new-replay-entry','stories/new',{value:2}));assert.equal(written.accepted,true);
  const before=applications,after=await journal.read(scope);
  assert.equal(applications-before,1,'only the newly accepted suffix is replayed');assert.equal(after.sequence,hot.sequence+1);
  const historical=await journal.read(scope,{through:hot.sequence});assert.deepEqual(historical,hot);
  const again=applications;assert.deepEqual(await journal.read(scope),after);assert.equal(applications,again,'historical views do not evict the current prefix');
}else if(request.mode==='reformat'){
  const envelope=JSON.parse(await filesystem.readFile(file,'utf8'));
  await filesystem.writeFile(file,JSON.stringify(envelope,null,2)+'\n');
  const before=applications;assert.deepEqual(await journal.read(scope),hot);assert.equal(applications-before,hot.sequence,'changed valid bytes use the original full validator');
  const next=applications;await journal.read(scope);assert.equal(applications,next);
}else if(request.mode==='permission'){
  denyReads=true;await assert.rejects(journal.read(scope),error=>error.code==='SDA_NAMESPACE_UNAVAILABLE'&&error.cause?.code==='EACCES');
}else if(request.mode==='corrupt'){
  const envelope=JSON.parse(await filesystem.readFile(file,'utf8'));envelope.body.transaction.changes[0].value='tampered';
  await filesystem.writeFile(file,JSON.stringify(envelope)+'\n');
  await assert.rejects(journal.read(scope),{code:'SDA_NAMESPACE_CORRUPT'});
}else if(request.mode==='missing'){
  await filesystem.rm(file);await assert.rejects(journal.read(scope,{through:hot.sequence}),{code:'SDA_NAMESPACE_CORRUPT'});
}else if(request.mode==='manifest'){
  await filesystem.rename(path.join(request.root,'store.json'),path.join(request.root,'store.kept'));
  await assert.rejects(journal.read(scope),error=>error.code==='SDA_NAMESPACE_UNAVAILABLE'&&error.cause?.code==='ENOENT');
}else if(request.mode==='eviction'){
  for(let number=0;number<9;number++){
    const other={projectId:'memo-project-'+number},empty=await journal.read(other);
    await journal.append(other,empty,put('seed-'+number,'records/value',number));await journal.read(other);
  }
  const before=applications;assert.deepEqual(await journal.read(scope),hot);assert.equal(applications-before,hot.sequence,'bounded project retention evicts an older prefix');
}else if(request.mode==='policy'){
  limits.maxValueBytes=1;
  const transaction=put('captured-policy','stories/captured',{original:'The declared bounds remain pinned.'});
  const accepted=await journal.append(scope,hot,transaction);assert.equal(accepted.accepted,true);
  const next=await journal.read(scope);
  assert.equal([...next.state.records.values()].find(value=>value.key==='stories/captured').value.original,'The declared bounds remain pinned.');
}else if(request.mode==='budget'){
  const other={projectId:'large-memo-project'},value='x'.repeat(60_000);
  for(let number=0;number<25;number++){
    const seen=await journal.read(other),keys=[0,1,2].map(index=>'large/'+number+'-'+index);
    await journal.append(other,seen,{operationId:'large-'+number,preconditions:keys.map(key=>({namespace:'state',key,version:null})),
      changes:keys.map(key=>({op:'put',namespace:'state',key,immutable:false,value})),events:[]});
  }
  const before=await journal.read(other),count=applications;assert.deepEqual(await journal.read(other),before);
  assert.ok(applications>count,'over-budget state is revalidated rather than retained indefinitely');
}else throw Error('Unknown replay fixture mode.');
process.stdout.write(JSON.stringify({ok:true,mode:request.mode,coldApplications,physicalReads,applications}));
