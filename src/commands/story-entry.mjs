/** Select optional worktree preparation without loading the lifecycle Story service. */
export function load({ positionals }) {
  return ['prepare-worktree', 'discard-worktree'].includes(positionals[1])
    ? import('../story-worktree-preparation.mjs') : import('./story.mjs');
}
export async function run(argv, context) {
  return (await load(context)).run(argv, context);
}
