import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCliBundle } from './build-cli-bundle.mjs';

/** Separate installation roots are essential: dynamic PACKAGE_ROOT imports must not cross variants. */
export async function buildCreationBenchmarkControl(fixture, source, controlRef) {
  const modules = fixture.git(['diff', '--name-only', controlRef, '--', 'src'], { cwd: source }).split('\n').filter(Boolean);
  if (!modules.length || modules.length > 32
      || modules.some(file => !/^src\/[a-zA-Z0-9_./-]+\.mjs$/u.test(file) || file.includes('..'))) {
    throw new Error('Comparison requires 1–32 bounded runtime modules.');
  }
  const controlFiles = new Set(fixture.git(['ls-tree', '-r', '--name-only', controlRef, '--', ...modules], { cwd: source }).split('\n'));
  const root = path.join(fixture.directory, 'control-engine');
  await mkdir(root);
  for (const name of ['src', 'bin', 'runtime', 'schemas', 'templates', 'plugin', 'docs', 'scripts',
    'distribution', 'package.json', 'revision-trace-manifest.json']) {
    await cp(path.join(fixture.engine, name), path.join(root, name), { recursive: true });
  }
  await symlink(path.join(fixture.engine, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of modules) {
    if (controlFiles.has(file)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), fixture.git(['show', `${controlRef}:${file}`], { cwd: source }) + '\n');
    } else await rm(path.join(root, file));
  }
  const { outdir } = await buildCliBundle({ root });
  // Detect the original managed-runtime packaging regression before invoking any product command.
  await readFile(path.join(root, 'runtime', 'resolve.cjs'));
  return { root, outdir, modules, candidateOnlyModules: modules.filter(file => !controlFiles.has(file)) };
}
