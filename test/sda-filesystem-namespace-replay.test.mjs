import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFilesystemNamespaceStore} from '../src/sda/filesystem-namespace-adapter.mjs';
import {putTransaction} from './helpers/namespace-conformance.mjs';
const run=promisify(execFile),scope={projectId:'replay-project'};
for(const mode of ['reuse','reformat','permission','corrupt','missing','manifest','eviction','policy','budget']){
  test('filesystem replay memoization: '+mode,async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'sflow-byte-replay-'));
    t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const store=await createFilesystemNamespaceStore({root,binding:{kind:'shared'},create:true});
    await store.transact(scope,putTransaction('first','stories/one',{nested:{retained:true}}));
    const result=await run(process.execPath,['--experimental-test-module-mocks','--no-warnings',
      fileURLToPath(new URL('./helpers/namespace-filesystem-replay-child.mjs',import.meta.url)),JSON.stringify({root,scope,mode})],
      {encoding:'utf8',timeout:60_000,maxBuffer:1024*1024});
    assert.equal(JSON.parse(result.stdout).ok,true);
  });
}
