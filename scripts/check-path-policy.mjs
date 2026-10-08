/** Normalize a host-native repository-relative path for policy comparisons. */
export function portableCheckPath(value) {
  return String(value).replaceAll('\\', '/');
}

/** Audit new files before Git staging too, without scanning ignored build/dependency files. */
export function sourceReferenceGrepArgs(pattern) {
  return ['grep', '--untracked', '--exclude-standard', '-n', '-i', '-E', pattern, '--', '.'];
}

/** Select every source surface covered by the model-name routing lint. */
export function isModelRoutingSource(value) {
  const relative = portableCheckPath(value);
  if (relative.startsWith('node_modules/') || relative.startsWith('.git/')) return false;
  if (relative === 'templates/modelTiers.yml') return false;
  if (relative.startsWith('test/') || relative.startsWith('docs/')) return false;
  // `plugin/skills/`, not `skills/` — the latter matches nothing, which would leave the
  // conversational routing surface unaudited while reporting a healthy file count.
  return relative.startsWith('plugin/skills/') || relative.startsWith('templates/')
    || relative === 'src/command-registry.mjs' || relative.endsWith('.agent.md');
}
