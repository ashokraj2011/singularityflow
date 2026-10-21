/** Source installation with a private runtime. Explicit alternative to the legacy global-npm installer. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installManagedRelease, installerProcess, rollbackManagedRelease, recoverManagedActivation } from './install.mjs';
import { installManagedProduct } from './product-install.mjs';
import resolver from './resolve.cjs';

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--skip-tests', '--cli-only', '--rollback', '--recover', '--help']);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Supported managed install options: --skip-tests, --cli-only, --rollback, --recover, --help. Legacy staged recovery must use its original installer.');
  if (args.includes('--help')) {
    console.log('Install/update CLI, SFlow VS Code extension and Copilot skills for this user: install-managed.sh / install-managed.ps1 [--skip-tests] [--cli-only] [--rollback | --recover]\nVS Code and Copilot CLI are prerequisites. No global Node/npm or administrator access required. Source remains in this workspace.');
    return;
  }
  const root = resolver.engineHome();
  if (args.includes('--recover')) {
    if (args.length !== 1) throw new Error('--recover must be used alone.');
    console.log(JSON.stringify(await recoverManagedActivation({ root })));
    return;
  }
  if (args.includes('--rollback')) {
    if (args.length !== 1) throw new Error('--rollback must be used alone.');
    console.log(JSON.stringify(await rollbackManagedRelease({ root })));
    return;
  }
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtimeRoot = path.dirname(path.dirname(process.execPath));
  const actualRuntimeRoot = process.platform === 'win32' ? path.dirname(process.execPath) : runtimeRoot;
  const npm = path.join(actualRuntimeRoot, ...(process.platform === 'win32' ? ['node_modules', 'npm'] : ['lib', 'node_modules', 'npm']), 'bin', 'npm-cli.js');
  if (!existsSync(npm)) throw new Error('Run the managed installer bootstrap; the private npm toolchain is unavailable.');
  const originalPath = process.env.PATH;
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${originalPath || ''}` };
  // This process is installer-only: private Node is never added to a persistent/application PATH.
  process.env.PATH = env.PATH;
  await installerProcess(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: source, env, timeoutMs: 600_000 });
  const { buildReinstallBundle, reinstallSourceDigest } = await import('../src/reinstall.mjs');
  const sourceSha256 = await reinstallSourceDigest(source);
  const registry = process.env.SINGULARITY_FLOW_NPM_REGISTRY || process.env.NPM_CONFIG_REGISTRY
    || (await installerProcess(process.execPath, [npm, 'config', 'get', 'registry'], { cwd: source, env, capture: true })).stdout.trim();
  const bundle = await buildReinstallBundle({ checkout: source, registry,
    cliOnly: args.includes('--cli-only'), skipTests: args.includes('--skip-tests'), sourceSha256 });
  // External integration managers must not inherit the build-only private Node PATH.
  process.env.PATH = originalPath;
  try {
    const sha256 = createHash('sha256').update(await readFile(bundle.tarball)).digest('hex');
    if (!args.includes('--cli-only')) {
      await installManagedProduct({ tarball: bundle.tarball, sha256, vsix: bundle.vsix, root });
      return;
    }
    const result = await installManagedRelease({ tarball: bundle.tarball, sha256, root });
    console.log(`Managed SFlow engine installed: ${result.build}\nNode: ${process.version}\nCommands: ${result.bin}`);
    console.log(`Add only this SFlow command directory to PATH: ${result.bin}\nDo not add its runtimes directory. Global node/npm and application toolchains are unchanged.`);
    if (bundle.vsix) {
      // Retain the exact built UI artifact beside this release, not the temporary build/source.
      const { copyFile } = await import('node:fs/promises');
      const vsix = path.join(root, 'releases', sha256, 'singularity-flow.vsix');
      await copyFile(bundle.vsix, vsix);
      console.log(`VS Code extension built and retained: ${vsix}\nInstall it with: code --install-extension "${vsix}" --force\nThe installed UI automatically resolves this managed engine; its extension-host Node is unchanged.`);
    }
    console.log(`For Copilot skills/hooks, use the managed command: ${path.join(result.bin, process.platform === 'win32' ? 'singularity-flow.cmd' : 'singularity-flow')} plugin install`);
  } finally {
    // This is the exact temporary build returned by the builder, never a workspace/source root.
    await rm(bundle.stagingParent, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`Managed SFlow installation failed: ${error.message}`); process.exitCode = 1; });
