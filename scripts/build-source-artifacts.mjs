#!/usr/bin/env node
/** Build a matching CLI and VS Code pair from source without activating an installation. */
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertReinstallNodeVersion, buildReinstallBundle, configuredReinstallRegistry, normalizeReinstallRegistry,
  reinstallSourceDigest, validateReinstallCheckout
} from '../src/install-source-build.mjs';
import {
  promoteReleaseDirectory, recoverReleaseDirectoryPromotion, releaseDirectoryLocations
} from '../src/release-directory-promotion.mjs';
import { canonicalPathSync, commandExists, run } from '../src/util.mjs';
import { inspectNpmTarballBuildSources, inspectVsixBuildSources } from './install-staged-artifacts.mjs';

async function assertPackageDestination(destination) {
  const info = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`The output path must be an ordinary directory. Choose a different --out-dir than ${destination}.`);
  }
  const entries = await readdir(destination, { withFileTypes: true });
  if (!entries.length) return;
  const tarball = entries.find(entry => entry.isFile() && /^singularity-flow-[0-9].*\.tgz$/u.test(entry.name));
  const vsix = tarball?.name.replace(/^singularity-flow-/u, 'singularity-flow-vscode-').replace(/\.tgz$/u, '.vsix');
  if (entries.length !== 2 || !entries.some(entry => entry.isFile() && entry.name === vsix)) {
    throw new Error(`${destination} contains files outside the SFlow package pair. Choose a different --out-dir.`);
  }
}

export async function buildSourceArtifacts({
  checkout: requestedCheckout, outputDirectory, registry, skipTests = false, execute = run, tempRoot = os.tmpdir(), log = console.log
}) {
  assertReinstallNodeVersion();
  if (!commandExists('npm')) throw new Error('npm is required on PATH to build the packages.');
  const { checkout, version } = await validateReinstallCheckout(requestedCheckout);
  const defaultOutput = path.join(checkout, 'dist');
  const output = path.resolve(outputDirectory ?? defaultOutput);
  const destination = path.join(canonicalPathSync(path.dirname(output)), path.basename(output));
  const fromOutputToSource = path.relative(destination, checkout);
  if (!fromOutputToSource || (!path.isAbsolute(fromOutputToSource) && fromOutputToSource !== '..' && !fromOutputToSource.startsWith('..' + path.sep))) {
    throw new Error('Choose an output folder separate from the source root.');
  }
  await recoverReleaseDirectoryPromotion(destination);
  await assertPackageDestination(destination);

  const registryOverride = registry ?? process.env.SINGULARITY_FLOW_NPM_REGISTRY ?? process.env.NPM_CONFIG_REGISTRY;
  const effectiveRegistry = registryOverride
    ? normalizeReinstallRegistry(registryOverride)
    : configuredReinstallRegistry(execute, process.env, checkout);
  const generated = [...new Set([defaultOutput, destination])].map(releaseDirectoryLocations);
  const excludeSource = relative => {
    const absolute = path.join(checkout, relative);
    return generated.some(item => [item.destination, item.journal, item.backup].includes(absolute)
      || path.dirname(absolute) === item.parent && path.basename(absolute).startsWith(item.candidatePrefix));
  };
  const scratch = await mkdtemp(path.join(tempRoot, 'sflow-source-artifacts-'));
  let candidate;
  try {
    const bundle = await buildReinstallBundle({
      checkout, registry: effectiveRegistry, skipTests, testScript: 'test:source-build',
      excludeSource, execute, tempRoot: scratch, log,
      sourceSha256: await reinstallSourceDigest(checkout, { excludeSource })
    });
    const layout = releaseDirectoryLocations(destination);
    await mkdir(layout.parent, { recursive: true });
    candidate = await mkdtemp(path.join(layout.parent, layout.candidatePrefix));
    const artifactNames = [path.basename(bundle.tarball), path.basename(bundle.vsix)];
    const staged = artifactNames.map(name => path.join(candidate, name));
    await Promise.all([copyFile(bundle.tarball, staged[0]), copyFile(bundle.vsix, staged[1])]);
    const [tarball, vsix] = await Promise.all([inspectNpmTarballBuildSources(staged[0]), inspectVsixBuildSources(staged[1])]);
    if (tarball.version !== version || vsix.version !== version ||
        tarball.versionSource !== vsix.versionSource || tarball.buildInfoSource !== vsix.buildInfoSource) {
      throw new Error('The staged tarball and VSIX do not contain the same SFlow build.');
    }
    await promoteReleaseDirectory(candidate, destination, {
      async afterStep(step) {
        if (step === 'journal-durable') await assertPackageDestination(destination);
      }
    });
    return { tarball: path.join(destination, artifactNames[0]), vsix: path.join(destination, artifactNames[1]) };
  } finally {
    for (const directory of [candidate, scratch].filter(Boolean)) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(error => {
        log(`Could not clean temporary build files at ${directory}. ${error.message}`);
      });
    }
  }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(script)) {
  try {
    const { values } = parseArgs({ options: {
      help: { type: 'boolean', short: 'h' }, registry: { type: 'string' }, 'out-dir': { type: 'string' }, 'skip-tests': { type: 'boolean' }
    } });
    if (values.help) console.log('Usage: ./install.sh --build-only [--registry URL] [--out-dir DIRECTORY] [--skip-tests]');
    else {
      const artifacts = await buildSourceArtifacts({
        checkout: path.dirname(path.dirname(script)), outputDirectory: values['out-dir'], registry: values.registry,
        skipTests: values['skip-tests']
      });
      console.log(`Built CLI package at ${artifacts.tarball}\nBuilt VS Code extension at ${artifacts.vsix}`);
    }
  } catch (error) {
    console.error(`Source package build failed. ${error.message}`);
    process.exitCode = 1;
  }
}
