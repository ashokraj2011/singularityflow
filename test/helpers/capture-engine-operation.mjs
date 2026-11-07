/** Observe the real SDK receipt in a fixture CLI process; never replace a domain result. */
import {mock} from 'node:test';
import {writeFile} from 'node:fs/promises';
import * as sdk from '../../src/engine-sdk/index.mjs';

if(process.env.NODE_ENV!=='test' || !process.env.SINGULARITY_FLOW_TEST_ENGINE_CAPTURE) {
  throw new Error('SDK capture requires an isolated test destination.');
}
mock.module(new URL('../../src/engine-sdk/index.mjs',import.meta.url).href,{namedExports:{
  ...sdk,
  createEngine(options) {
    const engine=sdk.createEngine(options);
    return Object.freeze({...engine,async run(operation,inputs,options){
      const result=await engine.run(operation,inputs,options);
      await writeFile(process.env.SINGULARITY_FLOW_TEST_ENGINE_CAPTURE,JSON.stringify({operation,result})+'\n',{mode:0o600});
      return result;
    }});
  }
}});
