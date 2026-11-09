/** Local fixture benchmark. No live repository, model invocation, Git or external service. */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--source-root'||!path.isAbsolute(args[1]))) {
  throw Error('Usage: node benchmarks/engine-sdk/namespace-io-profile.mjs [--source-root /absolute/source-checkout]');
}
const root=args[1]??fileURLToPath(new URL('../..',import.meta.url));
assert.equal(JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).name,'singularity-flow');
const {namespaceEngineFixture}=await import(pathToFileURL(path.join(root,'test/helpers/namespace-engine-fixture.mjs')));
const {configure}=await import(pathToFileURL(path.join(root,'test/helpers/namespace-routing-fixture.mjs')));
const cleanup=[],operations=[],counts=new Map();let active='construct';
try {
  const f=await namespaceEngineFixture({after(fn){cleanup.push(fn);}},{configure:configure('ask')});
  await f.bootstrap();
  const wrap=(label,target,names)=>({...target,...Object.fromEntries(names.map(name=>[name,async(...values)=>{
    const start=performance.now();
    try{return await target[name](...values);}
    finally{const key=active+':'+label+'.'+name,current=counts.get(key)??{calls:0,totalMs:0,maxMs:0};
      const elapsed=performance.now()-start;current.calls++;current.totalMs+=elapsed;current.maxMs=Math.max(current.maxMs,elapsed);counts.set(key,current);}
  }]))});
  const engine=f.make({records:wrap('records',f.records,['read','list','transact','inspectOperation','verify']),
    content:wrap('content',f.content,['read','put'])});
  async function run(operation,inputs={}) {
    active=operation+':'+(inputs.phaseId??'');const start=performance.now();
    try{return await engine.run(operation,inputs);}
    finally{operations.push({operation:active,ms:performance.now()-start});}
  }
  for(const phaseId of ['intake','review','release']) {
    f.asAuthor();await run('phase.prepare',{phaseId});const draft=await run('phase.draft.read',{phaseId});
    const body=(await f.local.content.put(f.scope,'local',Buffer.from('# Actual '+phaseId+' result\n\nGeneration 1 retains observable reviewed facts.\n'))).reference;
    await run('phase.draft.write',{operationId:'write-profile-'+phaseId,workId:f.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:body,reason:'Retain a real fixture document.'});
    await run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'});
    await run('phase.submit',{phaseId});f.asReviewer();const resources=await run('phase.review.resources',{phaseId});
    for(const resource of resources.manifest.resources)await run('document.read',{reference:resource.reference});
    await run('phase.approve',{phaseId,confirmation:{workId:f.workId,phase:phaseId,generation:resources.manifest.generation,
      reviewPacketSha256:resources.manifest.reviewBinding.packetSha256}});
    if(phaseId==='intake') {
      const context=await run('decision.context');await run('decision.choose',{workId:f.workId,expected:context.manifest.question.key,
        option:'continue',reason:'A fixture human selected the retained next phase.'});
    }
  }
  assert.equal((await f.capture()).workflow.status,'closed');
  const source=await readFile(path.join(root,'src/sda/filesystem-namespace-journal.mjs'));
  process.stdout.write(JSON.stringify({schemaVersion:1,scenario:'namespace-three-phase-ask-v1',
    platform:process.platform,architecture:process.arch,node:process.version,metadataBackend:'filesystem',contentBackend:'sqlite',
    journalSourceSha256:createHash('sha256').update(source).digest('hex'),status:'closed',
    totalMs:operations.reduce((sum,value)=>sum+value.ms,0),operations,
    ports:[...counts].map(([operation,value])=>({operation,...value})).sort((a,b)=>b.totalMs-a.totalMs)})+'\n');
}finally{for(const fn of cleanup.reverse())await fn();}
