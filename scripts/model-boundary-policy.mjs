const allowedCopilotLaunchers = new Set([
  'src/model-providers/copilot-cli.mjs',
  'src/host-session-launcher.mjs',
  // Plugin management invokes `copilot plugin`, not a model.
  'src/plugin.mjs',
  // Product reinstall replaces plugin registration only; it never opens a model session.
  'src/reinstall.mjs'
]);

/** Apply model-boundary policy to one portable repository path and its source text. */
export function modelBoundaryFailures(file, text) {
  // `path.relative` uses the host separator. Boundary policy is repository-relative, so compare
  // the same portable spelling on Windows and POSIX instead of accidentally revoking every
  // reviewed Windows exception.
  const repositoryFile = file.replaceAll('\\', '/');
  const failures = [];
  if (!allowedCopilotLaunchers.has(repositoryFile)
    && /(?:spawn|spawnSync|execFile|execFileSync|run|execute)\s*\([^\n]{0,100}['"`]copilot(?:\.cmd)?['"`]/.test(text)) {
    failures.push(`${repositoryFile}: starts Copilot outside the registered model/host boundary`);
  }
  if (repositoryFile !== 'src/model-provider-registry.mjs'
    && /from\s+['"`]\.\/model-providers\//.test(text)) {
    failures.push(`${repositoryFile}: imports a model provider directly instead of using model-runner.mjs`);
  }
  if (repositoryFile !== 'src/model-runner.mjs'
    && /from\s+['"`]\.\/model-provider-registry\.mjs['"`]/.test(text)) {
    failures.push(`${repositoryFile}: imports the provider registry directly instead of using model-runner.mjs`);
  }
  return failures;
}
