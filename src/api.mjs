import { repoRoot } from './git.mjs';
import { createFaultRepairApi } from './fault-repair.mjs';

/**
 * Stable in-process surface for integrations that should not scrape CLI output.
 * The returned methods call the same validation and policy boundary as the CLI.
 */
export function createSflow({ root = repoRoot(), faultRepairPolicy = {}, executionEnvironment = null } = {}) {
  let binding;
  const engine = async () => binding ??= import('./engine-compatibility/git-publication.mjs')
    .then(({ createGitEngine }) => createGitEngine({ root }).engine)
    .catch(error => { binding = undefined; throw error; });
  const executeOperation = async (operation, inputs, options) => (await engine()).run(operation, inputs, options);
  return Object.freeze({
    ...createFaultRepairApi(root, { policy: faultRepairPolicy, executionEnvironment }),
    run: executeOperation, publishPhase: (inputs, options) => executeOperation('phase.publish', inputs, options)
  });
}

export { createFaultRepairApi } from './fault-repair.mjs';
export { createEngine, ENGINE_CONTRACT, ENGINE_OPERATIONS } from './engine-sdk/index.mjs';
