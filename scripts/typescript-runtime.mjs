import path from 'node:path';

/**
 * Return the Node flags required to execute the extension's TypeScript sources directly.
 *
 * Native type stripping arrived in Node 22.6. The product still supports Node 20, where the
 * repository's bounded loader provides the same source-level test boundary. Keeping this decision
 * in one helper prevents nested test processes and utility scripts from accidentally raising the
 * effective minimum runtime.
 */
export function nodeTypeScriptFlags(rootDir, version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 20) {
    throw new Error(`TypeScript source execution requires Node.js 20 or newer; found v${version}.`);
  }
  return major > 22 || (major === 22 && minor >= 6)
    ? ['--experimental-strip-types', '--no-warnings=ExperimentalWarning']
    : ['--experimental-loader', path.join(rootDir, 'scripts', 'typescript-test-loader.mjs')];
}
