import { repoRoot } from './git.mjs';
import { createFaultRepairApi } from './fault-repair.mjs';
import {ENGINE_OPERATIONS} from './engine-sdk/index.mjs';

/**
 * Stable in-process surface for integrations that should not scrape CLI output.
 * The returned methods call the same validation and policy boundary as the CLI.
 */
export function createSflow({ root = repoRoot(), faultRepairPolicy = {}, executionEnvironment = null, notice = () => {} } = {}) {
  let binding,queryBinding;
  const native = async () => binding ??= import('./engine-compatibility/git-publication.mjs')
    .then(({ createGitEngine }) => createGitEngine({ root, notice }))
    .catch(error => { binding = undefined; throw error; });
  const queries=async()=>queryBinding??=import('./engine-compatibility/git-query.mjs')
    .then(({createGitQueryEngine})=>createGitQueryEngine({root}))
    .catch(error=>{queryBinding=undefined;throw error;});
  const executeOperation = async (operation, inputs, options) => {
    const selected=['phaseReview','documentRead','phaseEntry','workflowAssets'].includes(ENGINE_OPERATIONS.find(entry=>entry.id===operation)?.port)?await queries():await native();
    return selected.engine.run(operation,inputs,options);
  };
  return Object.freeze({
    ...createFaultRepairApi(root, { policy: faultRepairPolicy, executionEnvironment }),
    notifications: async () => (await native()).notifications(),
    run: executeOperation, publishPhase: (inputs, options) => executeOperation('phase.publish', inputs, options),
    beginPhase: (inputs, options) => executeOperation('phase.begin', inputs, options),
    preparePhase: (inputs, options) => executeOperation('phase.prepare', inputs, options),
    rolloverPhase: (inputs, options) => executeOperation('phase.rollover', inputs, options),
    prepublishPhase: (inputs, options) => executeOperation('phase.prepublish', inputs, options),
    draftCheckPhase: (inputs, options) => executeOperation('phase.draft-check', inputs, options),
    submitPhase: (inputs, options) => executeOperation('phase.submit', inputs, options),
    submitConvergence: (inputs, options) => executeOperation('convergence.submit', inputs, options),
    approvePhase:(inputs,options)=>executeOperation('phase.approve',inputs,options),
    recordDecisions:(inputs,options)=>executeOperation('decisions.record',inputs,options),
    advanceConvergence:(inputs,options)=>executeOperation('convergence.advance',inputs,options)
  });
}

export { createFaultRepairApi } from './fault-repair.mjs';
export { createEngine, ENGINE_CONTRACT, ENGINE_OPERATIONS } from './engine-sdk/index.mjs';
