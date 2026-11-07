/** Observe the real SDK receipt in a fixture CLI process; never replace a domain result. */
import {mock} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import * as sdk from '../../src/engine-sdk/index.mjs';

if(process.env.NODE_ENV!=='test' || !process.env.SINGULARITY_FLOW_TEST_ENGINE_CAPTURE) {
  throw new Error('SDK capture requires an isolated test destination.');
}
function observed(factory) {
  return options => {
    let bound=options;
    if(process.env.SINGULARITY_FLOW_TEST_NEXT_CONTEXT && options.ports?.storyNext) {
      const port=options.ports.storyNext;
      bound={...options,ports:{...options.ports,storyNext:{...port,async load(...args){
        const context=await port.load(...args);
        await writeFile(process.env.SINGULARITY_FLOW_TEST_NEXT_CONTEXT,JSON.stringify(context.presentation)+'\n',{mode:0o600});
        return context;
      }}}};
    }
    const engine=factory(bound);
    return Object.freeze({...engine,async run(operation,inputs,options){
      const result=await engine.run(operation,inputs,options);
      await writeFile(process.env.SINGULARITY_FLOW_TEST_ENGINE_CAPTURE,JSON.stringify({operation,result})+'\n',{mode:0o600});
      return result;
    }});
  };
}
mock.module(new URL('../../src/engine-sdk/index.mjs',import.meta.url).href,{namedExports:{
  ...sdk,createEngine:observed(sdk.createEngine),createStoryNextEngine:observed(sdk.createStoryNextEngine)
}});

// Some legacy hosts render words even with --json. Observe the real completed envelope without
// changing that output contract, the continuation planner, or any engine/domain result.
if(process.env.SINGULARITY_FLOW_TEST_COMMAND_CAPTURE) {
  const uri=new URL('../../src/narration/emit.mjs',import.meta.url).href;
  const host=await import(uri);
  mock.module(uri,{namedExports:{...host,emitCommandResult(...args) {
    const result=host.emitCommandResult(...args);
    writeFileSync(process.env.SINGULARITY_FLOW_TEST_COMMAND_CAPTURE,JSON.stringify(result)+'\n',{mode:0o600});
    return result;
  }}});
}
