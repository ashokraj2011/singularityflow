/** Actual approved Code and supporting documentation feed a custom deterministic convergence phase. */
import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture} from './namespace-release-fixture.mjs';
import {planText} from './namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
export async function namespaceConvergenceFixture(t,{backend='sqlite',supporting=true,...extra}={}){
  const f=await namespaceReleaseFixture(t,{...extra,backend,plan:planText+(supporting?'\n## Supporting files\n\n- `README.md` — explains the approved converter and its regression command\n':''),
    afterPrepare:async(_f,_engine,roots)=>{if(supporting)for(const root of roots)await writeFile(path.join(root,'README.md'),'# Converter\n\nRun the approved converter regression with node --test.\n');},
    configure(source){source.definition.phases.release.artifact.kind='convergence-report';
      source.definition.phases.release.generation={requirement:'required',producer:'deterministic',task:'analyze'};
      extra.configure?.(source);}});
  f.control.permissions.push('convergence.context','convergence.advance','phase.prepublish','phase.draft-check','story.next');
  const reviewerAccess={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},
    permissions:['convergence.context','convergence.adjudicate','phase.review','phase.approve','upstream.raise','upstream.decide']})};
  return {...f,reviewerAccess,reviewer:createNamespaceEngine({...f.options,checks:f.checks,access:reviewerAccess})};
}
