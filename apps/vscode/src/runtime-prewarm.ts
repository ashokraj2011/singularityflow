/** Kept out of activation and the ordinary panel graph. Loaded only after intake is visible. */
export { prewarmCliRuntime } from './cli/prewarm.ts';
import { IntakeWorktreePreparation } from './intake-worktree-preparation.ts';
import type { SingularityFlowClient } from './cli/client.ts';
export function intakePreparation(client: SingularityFlowClient): IntakeWorktreePreparation {
  const pinned = client.forkForRepository(client.repository);
  // Native Windows qualification found extra Git work and worse prepared-intake latency.
  // Keep this experiment available without adding it to every person's Start critical path.
  const prepareConfiguration = process.env.SINGULARITY_FLOW_INTAKE_CONFIGURATION_PREPARATION === 'on';
  return new IntakeWorktreePreparation(args => pinned.run(args),
    prepareConfiguration ? args => pinned.run(args, undefined, { priority: 'background' }) : null);
}
