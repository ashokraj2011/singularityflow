import { discoverAstAdapters } from './ast-adapter-contract.mjs';
import {
  compileAstLanguageCatalog, unsupportedAstProgrammingPaths
} from './ast-language-catalog.mjs';
import { SingularityFlowError } from './util.mjs';

export function assertAstProgrammingLanguagesSupported(paths, catalog, {
  boundary = 'governed operation'
} = {}) {
  const unsupported = unsupportedAstProgrammingPaths(paths, catalog);
  if (!unsupported.length) return { supported: true, unsupported: [] };
  const listed = unsupported.slice(0, 20).map((entry) => entry.path);
  const remainder = unsupported.length - listed.length;
  throw new SingularityFlowError(
    `Unsupported programming language blocks ${boundary}:\n- ${listed.join('\n- ')}`
    + (remainder > 0 ? `\n- … ${remainder} additional path(s)` : '')
    + '\nInstall a reviewed AST pack that advertises these extensions, or turn AST off with '
    + "'singularity-flow wm ast preference set off' to continue through normal Copilot file access. "
    + 'Run singularity-flow wm ast doctor --json to verify the resulting language catalog.',
    {
      code: 'AST_LANGUAGE_UNSUPPORTED',
      details: {
        paths: unsupported.map((entry) => entry.path),
        nextAction: 'Install a reviewed AST pack, or turn AST off to continue with normal Copilot file access.'
      }
    }
  );
}

export async function assertInstalledAstProgrammingLanguagesSupported(paths, options = {}) {
  const discovery = await discoverAstAdapters();
  const catalog = compileAstLanguageCatalog(discovery.adapters);
  return assertAstProgrammingLanguagesSupported(paths, catalog, options);
}
