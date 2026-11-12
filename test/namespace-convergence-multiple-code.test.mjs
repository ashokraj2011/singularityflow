import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceMultipleCodeCase} from './helpers/namespace-multiple-code-case.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
test('convergence retains three independently approved Code producers across two repositories',{timeout:600000},async t=>{
  const {f,starts}=await namespaceMultipleCodeCase(t,'sqlite',{release:true,convergence:true,repositories:2});
  f.control.agentId='release-reviewer';f.control.permissions.push('convergence.context','convergence.advance');
  const context=await f.engine.run('convergence.context',{phaseId:'release'}),projection=context.manifest.projection;
  assert.deepEqual(projection.source.inputs.map(row=>row.phase),['build','extend','finish']);
  assert.ok(projection.source.inputs.every(row=>row.approvals.length===1));assert.deepEqual(projection.projection.facts,[]);
  await f.engine.run('phase.prepare',{phaseId:'release'});const published=await f.engine.run('phase.publish',{phaseId:'release'}),preview=await f.engine.run('convergence.advance',{});
  await f.engine.run('convergence.advance',{confirmation:preview.confirmationDigest});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(starts(),8);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('Shared-only convergence publication cannot restamp its inputs.');}}});
  const retained=await replay.run('phase.publish',{phaseId:'release'});assert.equal(retained.status,'retained');assert.equal(retained.generation,published.generation);
});
