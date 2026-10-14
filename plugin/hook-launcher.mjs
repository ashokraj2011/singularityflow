import { existsSync, mkdirSync, realpathSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [action, ...candidates] = process.argv.slice(2);
const actions = new Set(['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start']);
// The shell launcher skips Node while no SFlow turn is recorded. A runtime that cannot load could
// not record one either, so leave a marker (RUNTIME_UNAVAILABLE_MARKER in
// copilot-repository-boundary.mjs) that sends later hooks back here, where the guard refuses.
function markRuntimeUnavailable() {
  try {
    const modeFile = path.resolve(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE
      || path.join(os.homedir(), '.singularity-flow', 'copilot-mode.json'));
    const directory = path.join(path.dirname(modeFile), 'copilot-boundaries');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, 'runtime-unavailable'), '', { mode: 0o600 });
  } catch { /* the refusal below still answers this hook */ }
}
const unavailable = () => {
  markRuntimeUnavailable();
  console.log(JSON.stringify(action === 'boundary-guard' ? {
    permissionDecision: 'deny', permissionDecisionReason:
      'SFLOW_HOOK_RUNTIME_UNAVAILABLE: Copilot cannot load the installed SFlow runtime. From a human terminal repair the installation, run singularity-flow plugin install, then reload VS Code. Preserve the Story; do not disable hooks or change its ID.'
  } : {}));
};

// No repository fallback, package download, shell profile, eval, or arbitrary supplied executable.
function packageFor(candidate) {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const entry = realpathSync(candidate);
    const root = path.dirname(path.dirname(entry));
    const relative = path.relative(process.cwd(), root);
    const underCwd = !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    const dependencyPrefix = root.split(`${path.sep}node_modules${path.sep}`)[0];
    // A neutral GUI cwd may be the user's home, which legitimately contains a global npm/nvm
    // installation. Reject repository/local dependencies, not every package below a non-Git cwd.
    if (!relative || (underCwd && (relative.split(path.sep)[0] === 'node_modules'
      || [process.cwd(), root, dependencyPrefix].some(directory => existsSync(path.join(directory, '.git')))))) return null;
    if (path.basename(entry) !== 'singularity-flow.mjs' || path.basename(path.dirname(entry)) !== 'bin'
        || !statSync(entry).isFile()) return null;
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== 'singularity-flow'
        || path.resolve(root, manifest.bin?.['singularity-flow'] ?? '') !== entry) return null;
    return root;
  } catch { return null; }
}

try {
  if (!actions.has(action)) console.log('{}');
  else {
    const root = candidates.map(packageFor).find(Boolean);
    if (!root) unavailable();
    else {
      // The installed bundle when it belongs to this build (src/bundled-cli.mjs), else the sources.
      // An older installed package has no selector: it simply runs its sources.
      const bundled = await import(pathToFileURL(path.join(root, 'src/bundled-cli.mjs')).href)
        .then(({ bundledCliUrl }) => bundledCliUrl(root), () => null);
      const { main } = await import(bundled ?? pathToFileURL(path.join(root, 'src/cli-entry.mjs')).href);
      await main(['hook', action]);
    }
  }
} catch { unavailable(); }
