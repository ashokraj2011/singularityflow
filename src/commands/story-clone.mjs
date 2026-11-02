/** Narrow, model-free clone entry. Creation delegates to the ordinary isolated Story start. */
import { repoRoot } from '../git.mjs';
import { optionBoolean, optionString, requirePositional, SingularityFlowError } from '../util.mjs';
import { readStoryClone } from '../story-clone.mjs';
import { validatePortableWorkId } from '../work-id.mjs';

export async function run(_argv, { positionals, options }) {
  const original = requirePositional(positionals, 2, 'original Story ID');
  const target = positionals[3];
  if (positionals.length > 4) throw new SingularityFlowError('Use story clone <ORIGINAL-ID> <NEW-ID> [--title <name>].');
  if (optionBoolean(options, 'preview')) {
    const draft = await readStoryClone(repoRoot(), original);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(draft, null, 2));
    console.log(`Clone ${draft.source.workId}: ${draft.request.title}\n${draft.notice}`);
    return draft;
  }
  if (!target) throw new SingularityFlowError('Give the clone a new Story ID: story clone <ORIGINAL-ID> <NEW-ID> --title <name>. Use --preview --json to inspect first.');
  validatePortableWorkId(target);
  const forwarded = { ...options, 'clone-from': original, 'isolated-worktree': true };
  if (optionString(options, 'clone-from') && optionString(options, 'clone-from') !== original) throw new SingularityFlowError('Choose one original Story.');
  const { run: start } = await import('./start.mjs');
  return start(['start', target], { positionals: ['start', target], options: forwarded });
}
