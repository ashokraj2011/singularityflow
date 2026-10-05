import { SingularityFlowError } from './util.mjs';

export const isDotnetManifest = (name) => /\.(?:slnx?|csproj|fsproj|vbproj)$/iu.test(name);

/** A single solution owns its projects. Multiple peer entry points require a human choice. */
export function selectDotnetManifest(names) {
  const sorted = [...new Set(names.filter(isDotnetManifest))].sort();
  const solutions = sorted.filter((name) => /\.slnx?$/iu.test(name));
  const candidates = solutions.length ? solutions : sorted;
  if (candidates.length > 1) throw new SingularityFlowError(
    `Multiple .NET build entry points require an explicit configured test command: ${candidates.join(', ')}.`,
    { code: 'DOTNET_MANIFEST_AMBIGUOUS', details: { manifests: candidates } }
  );
  return candidates[0] ?? null;
}
