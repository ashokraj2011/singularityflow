'use strict';
const fs = require('node:fs');
const path = require('node:path');
const compiler = require('node:module');

/** Cache only engine definitions. Does not change process.env, so application children keep theirs. */
function enableEngineCache(packageRoot) {
  if (process.env.NODE_DISABLE_COMPILE_CACHE === '1') return;
  try {
    if (!process.env.NODE_COMPILE_CACHE && path.basename(path.dirname(packageRoot)) === 'node_modules') {
      const release = path.dirname(path.dirname(packageRoot));
      const releases = path.dirname(release);
      const engine = path.dirname(releases);
      const runtimeRoot = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? '.' : '..');
      if (path.basename(releases) === 'releases' && /^[a-f0-9]{64}$/.test(path.basename(release))
          && path.dirname(runtimeRoot) === path.join(engine, 'runtimes')
          && Number(process.versions.node.split('.')[0]) >= 26) {
        const directory = path.join(engine, 'cache', path.basename(runtimeRoot), path.basename(release));
        // Preparation writes only when explicitly requested. Ordinary missing-cache requests compile
        // normally without creating/writing a cache, rather than delaying the foreground request.
        if (process.argv.includes('--warm-runtime')) return compiler.enableCompileCache?.({ directory, readOnly: false });
        if (fs.existsSync(directory)) return compiler.enableCompileCache?.({ directory, readOnly: true });
        return;
      }
    }
    return compiler.enableCompileCache?.();
  } catch { /* optional acceleration; no Story/approval state depends on bytecode */ }
}

module.exports = { enableEngineCache };
