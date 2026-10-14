import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { repoRoot } from '../git.mjs';
import { SingularityFlowError, optionBoolean } from '../util.mjs';
import { worldModelCommand } from '../worldmodel.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => wmCommand(positionals, options)));
}

export async function wmCommand(positionals, options) {
  if (positionals[1] !== 'design-inventory') {
    const root = repoRoot();
    const readsApprovedPolicy = new Set([
      'ast', 'facts', 'build', 'availability', 'status', 'ensure', 'refresh-authority',
      'context', 'check', 'show-prompt', 'brief', 'read', 'read-views', 'read-contract'
    ]).has(positionals[1]);
    return readsApprovedPolicy
      ? withApprovedConfigurationRead(root, () => worldModelCommand(root, positionals, options))
      : worldModelCommand(root, positionals, options);
  }
  if (!optionBoolean(options, 'from-records')) throw new SingularityFlowError('Design inventory generation is deterministic and requires --from-records.');
  const [
    { generateDesignInventory },
    { approvedDesignSourceBinding },
    { loadConfig, loadStoryAggregate, workDir }
  ] = await Promise.all([
    import('../design-inventory.mjs'),
    import('../design-sources.mjs'),
    import('../state-stores.mjs')
  ]);
  const root = repoRoot(), config = await loadConfig(root), workflow = await loadStoryAggregate(root, config);
  const binding = approvedDesignSourceBinding(workflow);
  const result = await generateDesignInventory(root, workflow, binding, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Design inventory: ${result.digest.digestSha256}\nJSON: ${result.json.path}\nMarkdown: ${result.markdown.path}`);
}
