import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {nativeEngineEntryInventory} from '../scripts/engine-native-entry-inventory.mjs';
import {COMMAND_REGISTRY} from '../src/command-registry.mjs';
async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'sflow-native-entry-audit-')));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
  const write=async(file,text)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);};
  const commands=[{name:'approve',aliases:['sign-off'],classification:'mutation',modulePath:'./commands/main.mjs'}],
    inspect=options=>nativeEngineEntryInventory({rootDir:root,commands,operationIds:['phase.approve'],helpers:{approvePhase:'phase.approve'},...options});
  await write('src/commands/main.mjs',"import '../kernel/rules.mjs';\nexport * from './shared/result.mjs';\nengine.run('phase.approve',{});\nengine.approvePhase({});\nawait import(selectedModule);\n");
  await write('src/kernel/rules.mjs',"throw Error('The audit must never execute this module.');\n");
  await write('src/commands/shared/result.mjs',"export const kind='retained';\n");
  return {root,write,inspect};}
test('the complete native command inventory includes all entry modules, original aliases and every literal source closure',async()=>{
  const report=await nativeEngineEntryInventory();
  assert.deepEqual(report.commands.map(row=>row.name),COMMAND_REGISTRY.map(row=>row.name));
  assert.ok(report.totals.entryPoints>=194);assert.ok(report.totals.modules>report.totals.entryPoints);
  assert.equal(report.modules.filter(row=>row.entryPoint).length,report.entryPoints.length);
  for(const row of report.commands){const native=COMMAND_REGISTRY.find(command=>command.name===row.name);
    assert.deepEqual(row.aliases,[...native.aliases]);assert.equal(row.module,'src/'+native.modulePath.slice(2));
    assert.ok(report.modules.some(module=>module.path===row.module));assert.ok(row.reachableModules>0);
    for(const id of row.observedOperations)assert.ok(typeof id==='string');}
  assert.ok(report.commands.find(row=>row.name==='reject').legacyDispatcher);
  assert.ok(report.modules.some(row=>row.path==='src/kernel/evidence-evaluation.mjs'));
  assert.deepEqual(report.unclassifiedDynamicImports,[],'Each new dynamic entry needs an explicitly reviewed responsibility.');
  for(const field of ['qualificationExecuted','callGraphProved','authorityGranted','readinessEstablished'])assert.equal(report[field],false);
});
test('the source inventory parses handlers without executing them and reports unresolved dynamic imports honestly',async t=>{
  const f=await fixture(t),view=await f.inspect();
  assert.deepEqual(view.entryPoints,['src/commands/main.mjs','src/commands/shared/result.mjs']);
  assert.equal(view.commands[0].reachableModules,3);assert.deepEqual(view.commands[0].kernelOwners,['src/kernel/rules.mjs']);
  assert.deepEqual(view.commands[0].observedOperations,['phase.approve']);
  assert.deepEqual(view.commands[0].unresolvedDynamicImports,[{path:'src/commands/main.mjs',line:5,kind:'import-expression',owner:null}]);
  assert.equal(view.unclassifiedDynamicImports.length,1,'An unreviewed dynamic entry cannot disappear into a success flag.');
  const module=view.modules.find(row=>row.path==='src/commands/main.mjs');
  assert.deepEqual(module.dispatchObservations.map(row=>row.kind),['operation-literal','helper-name']);
  view.commands[0].aliases.push('invented');assert.deepEqual((await f.inspect()).commands[0].aliases,['sign-off']);
});
test('literal lazy imports and import cycles are bounded without loading either target',async t=>{
  const f=await fixture(t);await f.write('src/kernel/rules.mjs',"import '../commands/main.mjs';\nawait import('../deferred.mjs');\n");
  await f.write('src/deferred.mjs',"throw Error('A lazy target must not run during the inventory.');\n");
  const view=await f.inspect();assert.equal(view.totals.modules,4);assert.equal(view.commands[0].reachableModules,4);
  assert.equal(view.modules.find(row=>row.path==='src/kernel/rules.mjs').imports[1].kind,'dynamic-literal');
});
test('a real missing native import preserves its filesystem error and exact path',async t=>{
  const f=await fixture(t);await rm(path.join(f.root,'src/kernel/rules.mjs'));
  await assert.rejects(f.inspect(),error=>error.code==='ENOENT'&&error.path===path.join(f.root,'src/kernel/rules.mjs'));
});
test('source and module limits refuse a partial inventory rather than reporting complete coverage',async t=>{
  const f=await fixture(t);
  for(const options of [{maximumModules:1},{maximumBytes:1},{maximumFileBytes:1}])await assert.rejects(f.inspect(options),{code:'ENGINE_NATIVE_INVENTORY_LIMIT'});
  await assert.rejects(f.inspect({maximumModules:0}),{code:'ENGINE_NATIVE_INVENTORY_INPUT'});
});
test('an escaped or linked native import is never used to read a different checkout',async t=>{
  const f=await fixture(t),outside=await mkdtemp(path.join(os.tmpdir(),'sflow-native-other-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(path.join(outside,'secret.mjs'),"export const value='private';\n");
  await rm(path.join(f.root,'src/kernel/rules.mjs'));await symlink(path.join(outside,'secret.mjs'),path.join(f.root,'src/kernel/rules.mjs'));
  await assert.rejects(f.inspect(),{code:'ENGINE_NATIVE_INVENTORY_PATH'});
  await f.write('src/commands/main.mjs',"import '../../../outside.mjs';\n");
  await assert.rejects(f.inspect(),{code:'ENGINE_NATIVE_INVENTORY_PATH'});
});
test('malformed syntax and ambiguous command identities cannot appear as a successfully audited entry',async t=>{
  const f=await fixture(t);await f.write('src/commands/main.mjs','export const = ;');
  await assert.rejects(f.inspect(),{code:'ENGINE_NATIVE_INVENTORY_SYNTAX'});
  await assert.rejects(f.inspect({commands:[{name:'approve',modulePath:'../outside.mjs'}]}),{code:'ENGINE_NATIVE_INVENTORY_INPUT'});
  assert.equal(await readFile(path.join(f.root,'src/commands/main.mjs'),'utf8'),'export const = ;');
});
