/**
 * The updater and everything it imports: Node built-ins only, so it runs from an extracted ZIP, from
 * the npm package, or from the copy VS Code's Update SFlow… menu takes out of its own VSIX before
 * the update replaces that VSIX. test/package-updater-standalone.test.mjs runs this list with no
 * repository and no node_modules, so a new import that is missing here fails there.
 */
export const UPDATER_FILES = Object.freeze([
  'update-sflow.sh', 'update-sflow.ps1',
  'runtime/update.mjs', 'runtime/install-pair.mjs', 'runtime/install.mjs', 'runtime/resolve.cjs',
  'runtime/bootstrap.sh', 'runtime/bootstrap.ps1', 'runtime/node-runtime.lock',
  'runtime/updater/artifacts.mjs', 'runtime/updater/sharepoint.mjs', 'runtime/updater/installer.mjs',
  'runtime/updater/process.mjs', 'runtime/updater/reinstall.mjs', 'runtime/updater/entry.mjs',
  'runtime/updater/source.mjs', 'runtime/updater/links.mjs', 'runtime/updater/local-folder.mjs', 'runtime/updater/cli-detect.mjs', 'runtime/updater/cli-install.mjs',
  'runtime/updater/files.mjs',
  'scripts/install-staged-artifacts.mjs'
]);
