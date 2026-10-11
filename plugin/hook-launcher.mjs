import { realpathSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [action, ...candidates] = process.argv.slice(2);
const actions = new Set(['boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start']);
const unavailable = () => console.log(JSON.stringify(action === 'boundary-guard' ? {
  permissionDecision: 'deny', permissionDecisionReason:
    'SFLOW_HOOK_RUNTIME_UNAVAILABLE: Copilot cannot load the installed SFlow runtime. From a human terminal repair the installation, run singularity-flow plugin install, then reload VS Code. Preserve the Story; do not disable hooks or change its ID.'
} : {}));

// No repository fallback, package download, shell profile, eval, or arbitrary supplied executable.
function packageFor(candidate) {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const entry = realpathSync(candidate);
    const root = path.dirname(path.dirname(entry));
    const relative = path.relative(process.cwd(), root);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return null;
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
      const { main } = await import(pathToFileURL(path.join(root, 'src/cli-entry.mjs')).href);
      await main(['hook', action]);
    }
  }
} catch { unavailable(); }
