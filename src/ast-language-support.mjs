import { discoverAstAdapters, inspectAstAdapterArtifacts } from './ast-adapter-contract.mjs';
import {
  compileAstLanguageCatalog, unsupportedAstProgrammingPaths
} from './ast-language-catalog.mjs';

export function assertAstProgrammingLanguagesSupported(paths, catalog, {
  boundary = 'governed operation', classifyUnknown = true
} = {}) {
  const unsupported = unsupportedAstProgrammingPaths(paths, catalog, { classifyUnknown });
  if (!unsupported.length) return { supported: true, unsupported: [] };
  return {
    supported: false,
    unsupported,
    diagnostic: {
      code: 'AST_LANGUAGE_UNSUPPORTED',
      severity: 'warn',
      message: `${unsupported.length} path(s) use a programming language unavailable to ${boundary}; those paths were skipped and ordinary file access remains available.`,
      paths: unsupported.map((entry) => entry.path)
    }
  };
}

export async function assertInstalledAstProgrammingLanguagesSupported(paths, options = {}) {
  const discovery = await discoverAstAdapters();
  const inspected = await Promise.all(discovery.adapters.map(async (adapter) => ({
    adapter, health: await inspectAstAdapterArtifacts(adapter)
  })));
  const catalog = compileAstLanguageCatalog(inspected.filter((entry) => entry.health.healthy).map((entry) => entry.adapter));
  return assertAstProgrammingLanguagesSupported(paths, catalog, options);
}
