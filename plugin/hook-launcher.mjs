import { existsSync, mkdirSync, realpathSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Node validates its bytecode cache against runtime and module bytes. Unsupported, disabled or
// unwritable caches fall back to normal execution; no permission/approval result is cached.
// Enable only after resolving the selected engine below: managed foreground hooks must not
// accidentally create a separate writable cache in the user's temporary directory.

const [action, ...given] = process.argv.slice(2);
// The shell launchers add this when `singularity-flow` is not on the PATH Copilot gave them, which its
// shell shares: the turn then names the Node and entry verified below (setHookCli in src/copilot-mode.mjs).
const OFF_PATH = '--cli-off-path';
const candidates = given.filter(value => value !== OFF_PATH);
const actions = new Set(['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start', 'boundary-stop', 'boundary-failure']);
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
  const reason = 'SFLOW_HOOK_RUNTIME_UNAVAILABLE: Copilot cannot load the installed SFlow runtime. From a human terminal repair the installation, run singularity-flow plugin install, then reload VS Code. Preserve the Story; do not disable hooks or change its ID.';
  console.log(JSON.stringify(action === 'boundary-guard' ? {
    permissionDecision: 'deny', permissionDecisionReason: reason,
    // VS Code's own chat reads a decision only here (hookAnswerForEveryHost in src/copilot-mode.mjs).
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
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
      try {
        const cache = path.join(root, 'runtime/cache.cjs');
        if (existsSync(cache)) (await import(pathToFileURL(cache).href)).default.enableEngineCache(root);
        else (await import('node:module')).enableCompileCache?.();
      } catch { /* optional startup optimization */ }
      const selector = await import(pathToFileURL(path.join(root, 'src/bundled-cli.mjs')).href)
        .catch(() => null);
      const hookSource = path.join(root, 'src/copilot-hook-runtime.mjs');
      // Diagnostic fallback changes the transport, never the policy. Older installations keep
      // their verified CLI route; a present but broken dedicated runtime fails closed below.
      if (process.env.SINGULARITY_FLOW_HOOK_RUNTIME !== 'legacy' && existsSync(hookSource)) {
        const bundled = selector?.bundledCopilotHookUrl?.(root);
        const { runCopilotHook } = await import(bundled ?? pathToFileURL(hookSource).href);
        await runCopilotHook(action, process.stdin, { node: process.execPath,
          cli: path.join(root, 'bin', 'singularity-flow.mjs'), onPath: !given.includes(OFF_PATH) });
      } else {
        const bundled = selector?.bundledCliUrl?.(root);
        const { main } = await import(bundled ?? pathToFileURL(path.join(root, 'src/cli-entry.mjs')).href);
        await main(['hook', action]);
      }
    }
  }
} catch { unavailable(); }
