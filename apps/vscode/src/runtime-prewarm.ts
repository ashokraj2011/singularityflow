/** Kept out of activation and the ordinary panel graph. Loaded only after intake is visible. */
export { prewarmCliRuntime } from './cli/prewarm.ts';
import { IntakeWorktreePreparation } from './intake-worktree-preparation.ts';
import type { SingularityFlowClient } from './cli/client.ts';
export function createIntakePreparation(client: SingularityFlowClient): IntakeWorktreePreparation {
  const pinned = client.forkForRepository(client.repository);
  return new IntakeWorktreePreparation(args => pinned.run(args));
}
