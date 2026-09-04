import { repoRoot } from '../git.mjs';
import { optionBoolean } from '../util.mjs';
import { showCapability } from './capability.mjs';

export async function run(_argv, context = {}) {
  return showCapability(repoRoot(), context.positionals?.[1] ?? '', {
    json: optionBoolean(context.options ?? {}, 'json'),
    verbose: optionBoolean(context.options ?? {}, 'verbose')
  });
}
