/** Capture the actual installed compiler composition, without replacing any policy implementation. */
import { registerHooks } from 'node:module';

export function captureConfigurationCompiler() {
  const key=Symbol.for('sflow.test.configuration-compiler');
  const target=new URL('../../src/kernel/workflow-configuration.mjs',import.meta.url).href;
  const parent=new URL('../../src/config.mjs',import.meta.url).href;
  let captured=null;
  if (Object.hasOwn(globalThis,key)) throw new Error('A configuration capture is already active.');
  globalThis[key]=(dependencies,compiler)=>{ captured={dependencies,compiler}; };
  const wrapper='data:text/javascript,'+encodeURIComponent(`
    export * from ${JSON.stringify(target)};
    import { createWorkflowConfigurationCompiler as compile } from ${JSON.stringify(target)};
    export function createWorkflowConfigurationCompiler(dependencies) {
      const compiler=compile(dependencies);
      globalThis[Symbol.for('sflow.test.configuration-compiler')](dependencies,compiler);
      return compiler;
    }
  `);
  const hook=registerHooks({resolve(specifier,context,next) {
    if (context.parentURL===parent&&specifier==='./kernel/workflow-configuration.mjs') {
      return {url:wrapper,shortCircuit:true};
    }
    return next(specifier,context);
  }});
  return {
    get value() { if(!captured)throw new Error('The installed compiler has not been constructed.');return captured; },
    close() {hook.deregister();delete globalThis[key];}
  };
}
