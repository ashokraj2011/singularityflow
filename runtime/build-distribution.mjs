/** One build command. Runtime bootstrap is handled by build-distribution.sh / .ps1. */
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installerProcess } from './install.mjs';

export function buildDistributionOptions(argv, { environment = process.env, homeDirectory = os.homedir(), repository } = {}) {
  const keys = path.join(homeDirectory, '.singularity-flow', 'distribution-keys');
  const result = { signingKey: environment.SINGULARITY_FLOW_DISTRIBUTION_SIGNING_KEY || path.join(keys, 'artifact-builder-private.pem'),
    identity: environment.SINGULARITY_FLOW_DISTRIBUTION_BUILDER || 'local-distribution-builder',
    outDirectory: path.join(repository, 'dist'), skipTests: false, help: false };
  const values = { '--signing-key': 'signingKey', '--identity': 'identity', '--out-dir': 'outDirectory' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--skip-tests') result.skipTests = true;
    else if (argument === '--help') result.help = true;
    else if (values[argument]) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${argument} requires a value.`);
      result[values[argument]] = argv[++index];
    } else throw new Error(`Unknown distribution build option: ${argument}`);
  }
  result.signingKey = path.resolve(result.signingKey); result.outDirectory = path.resolve(result.outDirectory);
  return result;
}

async function main() {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const options = buildDistributionOptions(process.argv.slice(2), { repository });
  if (options.help) {
    console.log('Build an installable signed candidate: build-distribution.sh / build-distribution.ps1 [--signing-key PATH] [--identity NAME] [--out-dir DIRECTORY] [--skip-tests]\nA local user-only builder key is created on first build when no key is configured. This does not certify or promote a production release.');
    return;
  }
  const runtimeRoot = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? '.' : '..');
  const npm = path.join(runtimeRoot, ...(process.platform === 'win32' ? ['node_modules', 'npm'] : ['lib', 'node_modules', 'npm']), 'bin', 'npm-cli.js');
  const environment = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  // Canonical builders also bootstrap their locked npm through PATH. This process performs builds
  // only; keep that bootstrap private even on a machine with no global Node/npm at all.
  process.env.PATH = environment.PATH;
  await installerProcess(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: repository, env: environment, timeoutMs: 600_000 });
  // Product modules load only after the locked dependencies are ready on this first build.
  const { readSecurePrivateKey } = await import('../src/secure-private-key.mjs');
  const { secureWindowsAuthAcl } = await import('../src/mcp-auth-profile.mjs');
  const { buildReleaseArtifacts } = await import('../scripts/build-release-artifacts.mjs');
  const { assembleCandidateDistribution } = await import('../src/distribution-build.mjs');
  const info = await lstat(options.signingKey).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) {
    const defaultKey = path.join(os.homedir(), '.singularity-flow', 'distribution-keys', 'artifact-builder-private.pem');
    if (options.signingKey !== defaultKey) throw new Error('The explicitly configured signing key does not exist; it was not replaced.');
    const directory = path.dirname(defaultKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (process.platform !== 'win32' && ((metadata.mode & 0o077) || metadata.uid !== process.getuid()))) throw new Error('Local builder-key directory must be private to this user.');
    const pair = generateKeyPairSync('ed25519');
    await writeFile(defaultKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') await secureWindowsAuthAcl(defaultKey, { apply: true });
    console.log('Created a private local artifact-builder key. It is not a production approval or release-verification key.');
  }
  const key = await readSecurePrivateKey(options.signingKey, { repository, label: 'Artifact signing key' });
  const publicKey = createPublicKey(key.bytes).export({ type: 'spki', format: 'pem' });
  const publicKeyPath = path.join(path.dirname(options.signingKey), 'artifact-builder-public.pem');
  const oldPublic = await lstat(publicKeyPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (oldPublic) {
    if (!oldPublic.isFile() || oldPublic.isSymbolicLink() || await readFile(publicKeyPath, 'utf8') !== publicKey) throw new Error('Builder public-key output conflicts with retained trust material; preserved.');
  } else await writeFile(publicKeyPath, publicKey, { flag: 'wx', mode: 0o600 });
  await installerProcess(process.execPath, [npm, 'run', 'check'], { cwd: repository, env: environment, timeoutMs: 600_000 });
  if (!options.skipTests) {
    await installerProcess(process.execPath, [npm, 'run', 'test:reinstall'], { cwd: repository, env: environment, timeoutMs: 1_800_000 });
    await installerProcess(process.execPath, ['--test', 'test/managed-runtime.test.mjs', 'test/managed-product-install.test.mjs'], { cwd: repository, env: environment, timeoutMs: 600_000 });
  }
  const temporary = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'sflow-one-build-')));
  try {
    // The canonical builder requires a fresh output directory and an exact clean Git subject.
    const built = await buildReleaseArtifacts({ repository, signingKey: options.signingKey, identity: options.identity,
      outputDirectory: path.join(temporary, 'artifacts') });
    const result = await assembleCandidateDistribution({ artifactReceipt: built.receipt,
      packagePath: built.packagePath, vsixPath: built.vsixPath, trustedPublicKeyPem: publicKey, destination: options.outDirectory });
    console.log(`\nSigned installable distribution: ${result.directory}\nStatus: ${result.status}\nPublic trust key (distribute independently): ${publicKeyPath}\nPrivate signing key remains outside the distribution.\nMac: bash setup.sh --artifact-key <trusted-public-key>\nWindows: setup.cmd --artifact-key <trusted-public-key>\nAfter the first trusted setup, the same setup command needs no key argument for updates.\nProduction certification still requires the existing signed release matrix; no approval evidence was generated.`);
  } finally { await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true })); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Distribution build failed: ${error.message}`); process.exitCode = 1; });
}
