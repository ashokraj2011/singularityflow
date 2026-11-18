/** Independent service adapter stays outside the shared CLI/read bundle closure. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';

export async function run(argv, context) {
  const adapter = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'local-ui', 'cli.mjs')).href);
  return adapter.run(argv, context);
}
