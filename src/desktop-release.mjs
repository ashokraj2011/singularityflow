import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_SCHEMA_VERSION = 1;
export const DESKTOP_PLATFORMS = ['mac', 'win'];
export const SIGNING_MODES = ['off', 'auto', 'required'];
export const RELEASE_MODES = ['local', 'official'];

const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function optionValue(argv, index, inline, name) {
  if (inline !== undefined) return { value: inline, consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return { value, consumed: 1 };
}

export function parseDesktopReleaseArgs(argv = []) {
  const args = [...argv];
  const knownActions = new Set(['package', 'preflight', 'verify', 'combine', 'publish-artifactory']);
  let action = 'package';
  if (args[0] && !args[0].startsWith('--')) {
    action = args.shift();
    if (!knownActions.has(action)) throw new Error(`Unknown desktop release action '${action}'.`);
  }
  const options = {
    action,
    platform: 'current',
    sign: 'auto',
    releaseMode: 'local',
    dir: null,
    tag: null,
    inputs: [],
    allowDirty: false,
    dryRun: false,
    replace: false,
    skipTests: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected desktop release argument '${argument}'.`);
    const [name, inline] = argument.split(/=(.*)/s, 2);
    if (['--allow-dirty', '--dry-run', '--replace', '--skip-tests'].includes(name)) {
      const key = { '--allow-dirty': 'allowDirty', '--dry-run': 'dryRun', '--replace': 'replace', '--skip-tests': 'skipTests' }[name];
      options[key] = true;
      continue;
    }
    if (!['--platform', '--sign', '--release-mode', '--dir', '--tag', '--input'].includes(name)) throw new Error(`Unknown desktop release option '${name}'.`);
    const parsed = optionValue(args, index, inline, name);
    index += parsed.consumed;
    if (name === '--input') options.inputs.push(parsed.value);
    else options[{ '--platform': 'platform', '--sign': 'sign', '--release-mode': 'releaseMode', '--dir': 'dir', '--tag': 'tag' }[name]] = parsed.value;
  }
  if (!['current', ...DESKTOP_PLATFORMS].includes(options.platform)) throw new Error(`Desktop platform must be current, mac, or win.`);
  if (!SIGNING_MODES.includes(options.sign)) throw new Error(`Signing mode must be ${SIGNING_MODES.join(', ')}.`);
  if (!RELEASE_MODES.includes(options.releaseMode)) throw new Error(`Release mode must be ${RELEASE_MODES.join(' or ')}.`);
  if (options.releaseMode === 'official' && options.sign !== 'required' && action === 'package') throw new Error(`Official packages require --sign required.`);
  return options;
}

export function normalizeDesktopPlatform(value = 'current', host = process.platform) {
  if (value === 'mac' || value === 'win') return value;
  if (value !== 'current') throw new Error(`Unknown desktop platform '${value}'.`);
  if (host === 'darwin') return 'mac';
  if (host === 'win32') return 'win';
  throw new Error('Desktop installers must be packaged on macOS or Windows; use a platform-specific CI runner.');
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

export async function desktopVersionInfo(root) {
  const packageJson = await json(path.join(root, 'package.json'));
  const desktopJson = await json(path.join(root, 'apps/desktop/package.json'));
  const pluginJson = await json(path.join(root, 'plugin/plugin.json'));
  const marketplaceJson = await json(path.join(root, '.github/plugin/marketplace.json'));
  const lockJson = await json(path.join(root, 'package-lock.json'));
  const marketplacePlugin = marketplaceJson.plugins?.find((item) => item.name === 'singularity-flow');
  const versions = {
    package: packageJson.version,
    desktop: desktopJson.version,
    plugin: pluginJson.version,
    marketplace: marketplaceJson.metadata?.version,
    marketplacePlugin: marketplacePlugin?.version,
    lockPackage: lockJson.packages?.['']?.version,
    lockDesktop: lockJson.packages?.['apps/desktop']?.version
  };
  const distinct = unique(Object.values(versions));
  if (Object.values(versions).some((value) => !value) || distinct.length !== 1) {
    throw new Error(`Desktop release version mismatch: ${Object.entries(versions).map(([name, value]) => `${name}=${value ?? 'missing'}`).join(', ')}.`);
  }
  return {
    version: distinct[0],
    electronVersion: desktopJson.devDependencies?.electron ?? null,
    versions
  };
}

export function assertReleaseTag(version, tag) {
  if (!tag) return;
  if (tag !== `v${version}`) throw new Error(`Release tag '${tag}' does not match package version ${version}; expected v${version}.`);
}

export function signingPlan(platform, mode, env = process.env) {
  if (!DESKTOP_PLATFORMS.includes(platform)) throw new Error(`Unknown desktop platform '${platform}'.`);
  if (!SIGNING_MODES.includes(mode)) throw new Error(`Unknown signing mode '${mode}'.`);
  const macCertificate = env.MAC_CSC_LINK || env.CSC_LINK;
  const macPassword = env.MAC_CSC_KEY_PASSWORD || env.CSC_KEY_PASSWORD;
  const appleKey = env.APPLE_API_KEY_B64 || env.APPLE_API_KEY;
  const windowsCertificate = env.WIN_CSC_LINK;
  const windowsPassword = env.WIN_CSC_KEY_PASSWORD;
  const required = platform === 'mac'
    ? [
        ['MAC_CSC_LINK (or CSC_LINK)', macCertificate],
        ['MAC_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD)', macPassword],
        ['APPLE_API_KEY_B64 (or APPLE_API_KEY)', appleKey],
        ['APPLE_API_KEY_ID', env.APPLE_API_KEY_ID],
        ['APPLE_API_ISSUER', env.APPLE_API_ISSUER]
      ]
    : [
        ['WIN_CSC_LINK', windowsCertificate],
        ['WIN_CSC_KEY_PASSWORD', windowsPassword]
      ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  const enabled = mode !== 'off' && missing.length === 0;
  if (mode === 'required' && missing.length) throw new Error(`Required ${platform === 'mac' ? 'macOS signing/notarization' : 'Windows signing'} configuration is missing: ${missing.join(', ')}.`);
  return {
    mode,
    enabled,
    signed: enabled,
    notarized: platform === 'mac' && enabled,
    missing,
    environment: platform === 'mac'
      ? { certificate: macCertificate, password: macPassword, appleKey }
      : { certificate: windowsCertificate, password: windowsPassword }
  };
}

export function desktopArtifactNames({ version, platform, releaseMode = 'local', signed = false }) {
  if (!version) throw new Error('Desktop artifact version is required.');
  if (!DESKTOP_PLATFORMS.includes(platform)) throw new Error(`Unknown desktop platform '${platform}'.`);
  if (releaseMode === 'official' && !signed) throw new Error('Official desktop artifacts must be signed.');
  const suffix = releaseMode === 'official' ? '' : signed ? '-signed-local' : '-unsigned';
  if (platform === 'mac') {
    const stem = `singularity-flow-desktop-${version}-macos-universal${suffix}`;
    return [`${stem}.dmg`, `${stem}.zip`];
  }
  return [`singularity-flow-desktop-${version}-windows-x64${suffix}-setup.exe`];
}

export function builderArtifactTemplate({ version, platform, releaseMode = 'local', signed = false }) {
  const first = desktopArtifactNames({ version, platform, releaseMode, signed })[0];
  if (platform === 'mac') return first.replace(/\.dmg$/, '.${ext}');
  return first.replace(/\.exe$/, '.${ext}');
}

export function desktopReleaseDirectory(root, version, releaseMode = 'local') {
  return path.join(root, 'apps', 'desktop', 'release', releaseMode, version);
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function fileRecord(directory, name, platform, signed, notarized) {
  const absolute = path.join(directory, name);
  const information = await stat(absolute).catch(() => null);
  if (!information?.isFile() || information.size === 0) throw new Error(`Desktop release artifact is missing or empty: ${name}.`);
  return {
    name,
    platform,
    architecture: platform === 'mac' ? 'universal' : 'x64',
    bytes: information.size,
    sha256: await sha256File(absolute),
    signed,
    notarized: platform === 'mac' ? notarized : false
  };
}

export async function createDesktopReleaseManifest({
  directory,
  version,
  commit,
  electronVersion,
  platform,
  releaseMode,
  signed,
  notarized,
  verified = true,
  builtAt = new Date().toISOString(),
  nodeVersion = process.version
}) {
  const names = desktopArtifactNames({ version, platform, releaseMode, signed });
  const artifacts = [];
  for (const name of names) artifacts.push(await fileRecord(directory, name, platform, signed, notarized));
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    product: 'Singularity Flow',
    version,
    commit,
    releaseMode,
    verified,
    builtAt,
    electronVersion,
    nodeVersion,
    artifacts
  };
}

export async function writeDesktopReleaseMetadata(directory, manifest, { manifestName = 'release-manifest.json' } = {}) {
  await mkdir(directory, { recursive: true });
  const sorted = [...manifest.artifacts].sort((left, right) => left.name.localeCompare(right.name));
  const sums = `${sorted.map((item) => `${item.sha256}  ${item.name}`).join('\n')}\n`;
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums, 'utf8');
  await writeFile(path.join(directory, manifestName), `${JSON.stringify({ ...manifest, artifacts: sorted }, null, 2)}\n`, 'utf8');
  return { manifest: path.join(directory, manifestName), checksums: path.join(directory, 'SHA256SUMS.txt') };
}

export async function verifyDesktopReleaseDirectory(directory, { requireOfficial = false } = {}) {
  const file = path.join(directory, 'release-manifest.json');
  const manifest = await json(file).catch((error) => { throw new Error(`Unable to read desktop release manifest at ${file}: ${error.message}`); });
  if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION) throw new Error(`Unsupported desktop release manifest schema ${manifest.schemaVersion}.`);
  if (!manifest.verified) throw new Error('Desktop release manifest is not marked verified.');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Desktop release manifest contains no artifacts.');
  if (requireOfficial && manifest.releaseMode !== 'official') throw new Error('Only official desktop release manifests can be published.');
  for (const artifact of manifest.artifacts) {
    if (path.basename(artifact.name) !== artifact.name) throw new Error(`Unsafe desktop artifact name '${artifact.name}'.`);
    const absolute = path.join(directory, artifact.name);
    const information = await stat(absolute).catch(() => null);
    if (!information?.isFile() || information.size !== artifact.bytes) throw new Error(`Desktop artifact size mismatch: ${artifact.name}.`);
    if (await sha256File(absolute) !== artifact.sha256) throw new Error(`Desktop artifact SHA-256 mismatch: ${artifact.name}.`);
    if (requireOfficial && !artifact.signed) throw new Error(`Official desktop artifact is not signed: ${artifact.name}.`);
    if (requireOfficial && artifact.platform === 'mac' && !artifact.notarized) throw new Error(`Official macOS artifact is not notarized: ${artifact.name}.`);
  }
  const expectedSums = `${[...manifest.artifacts].sort((a, b) => a.name.localeCompare(b.name)).map((item) => `${item.sha256}  ${item.name}`).join('\n')}\n`;
  const actualSums = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8').catch(() => '');
  if (actualSums !== expectedSums) throw new Error('Desktop release checksum file does not match the manifest.');
  return manifest;
}

export async function combineDesktopReleaseFragments({ directory, inputs }) {
  if (!inputs?.length) throw new Error('At least one desktop release manifest input is required.');
  await mkdir(directory, { recursive: true });
  const manifests = [];
  for (const input of inputs) manifests.push(await json(path.resolve(input)));
  const versions = unique(manifests.map((item) => item.version));
  const commits = unique(manifests.map((item) => item.commit));
  const modes = unique(manifests.map((item) => item.releaseMode));
  if (versions.length !== 1 || commits.length !== 1 || modes.length !== 1) throw new Error('Desktop release fragments must use the same version, commit, and release mode.');
  const artifacts = [];
  for (let index = 0; index < manifests.length; index += 1) {
    const manifest = manifests[index];
    const sourceDirectory = path.dirname(path.resolve(inputs[index]));
    for (const artifact of manifest.artifacts ?? []) {
      if (artifacts.some((item) => item.name === artifact.name)) throw new Error(`Duplicate desktop release artifact '${artifact.name}'.`);
      const source = path.join(sourceDirectory, artifact.name);
      const destination = path.join(directory, artifact.name);
      await writeFile(destination, await readFile(source));
      artifacts.push(artifact);
    }
  }
  const combined = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    product: 'Singularity Flow',
    version: versions[0],
    commit: commits[0],
    releaseMode: modes[0],
    verified: manifests.every((item) => item.verified === true),
    builtAt: manifests.map((item) => item.builtAt).sort().at(-1),
    electronVersion: unique(manifests.map((item) => item.electronVersion)).join(', '),
    nodeVersion: unique(manifests.map((item) => item.nodeVersion)).join(', '),
    artifacts
  };
  await writeDesktopReleaseMetadata(directory, combined);
  await verifyDesktopReleaseDirectory(directory, { requireOfficial: modes[0] === 'official' });
  return combined;
}

function artifactoryConfiguration(env) {
  const baseUrl = env.SINGULARITY_FLOW_ARTIFACTORY_BASE_URL;
  const repository = env.SINGULARITY_FLOW_ARTIFACTORY_REPOSITORY;
  const token = env.SINGULARITY_FLOW_ARTIFACTORY_TOKEN;
  const user = env.SINGULARITY_FLOW_ARTIFACTORY_USER;
  const missing = [
    ['SINGULARITY_FLOW_ARTIFACTORY_BASE_URL', baseUrl],
    ['SINGULARITY_FLOW_ARTIFACTORY_REPOSITORY', repository],
    ['SINGULARITY_FLOW_ARTIFACTORY_TOKEN', token]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Artifactory configuration is missing: ${missing.join(', ')}.`);
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') throw new Error('Artifactory base URL must use HTTPS.');
  if (!/^[A-Za-z0-9._-]+$/.test(repository)) throw new Error('Artifactory repository must be a single safe repository name.');
  const authorization = user
    ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`
    : `Bearer ${token}`;
  return { baseUrl: parsed.href.replace(/\/$/, ''), repository, authorization };
}

async function fetchWithRetries(fetchImpl, url, options, retries = 3) {
  let response;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try { response = await fetchImpl(url, options); } catch (error) {
      if (attempt === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      continue;
    }
    if (!transientStatuses.has(response.status) || attempt === retries - 1) return response;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return response;
}

export async function publishDesktopReleaseToArtifactory(directory, {
  env = process.env,
  dryRun = false,
  replace = false,
  fetchImpl = globalThis.fetch
} = {}) {
  const manifest = await verifyDesktopReleaseDirectory(directory, { requireOfficial: true });
  const configuration = artifactoryConfiguration(env);
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch-compatible implementation is required for Artifactory publication.');
  const files = [...manifest.artifacts.map((item) => item.name), 'SHA256SUMS.txt', 'release-manifest.json'];
  const uploads = [];
  for (const name of files) {
    const encodedName = encodeURIComponent(name).replaceAll('%2F', '/');
    const url = `${configuration.baseUrl}/${configuration.repository}/singularity-flow-desktop/${encodeURIComponent(manifest.version)}/${encodedName}`;
    if (dryRun) {
      uploads.push({ name, url, status: 'dry-run' });
      continue;
    }
    if (!replace) {
      const existing = await fetchWithRetries(fetchImpl, url, { method: 'HEAD', headers: { Authorization: configuration.authorization } });
      if (existing.ok) throw new Error(`Artifactory already contains ${name}; use --replace to overwrite deliberately.`);
      if (existing.status !== 404) throw new Error(`Artifactory existence check failed for ${name}: HTTP ${existing.status}.`);
    }
    const body = await readFile(path.join(directory, name));
    const checksum = createHash('sha256').update(body).digest('hex');
    const uploaded = await fetchWithRetries(fetchImpl, url, {
      method: 'PUT',
      headers: {
        Authorization: configuration.authorization,
        'Content-Type': 'application/octet-stream',
        'X-Checksum-Sha256': checksum
      },
      body
    });
    if (!uploaded.ok) throw new Error(`Artifactory upload failed for ${name}: HTTP ${uploaded.status}.`);
    uploads.push({ name, url, status: uploaded.status, sha256: checksum });
  }
  return { version: manifest.version, repository: configuration.repository, uploads };
}

export async function releaseDirectoryFiles(directory) {
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

export function requiredDesktopBundlePaths(root) {
  return [
    'bin/singularity-flow.mjs',
    'src/cli.mjs',
    'templates/workflow.yml',
    'plugin/plugin.json',
    'HELP.md',
    'node_modules/yaml',
    'package.json',
    'apps/desktop/electron/main.mjs',
    'apps/desktop/electron/preload.cjs',
    'apps/desktop/build/icon.png',
    'apps/desktop/build/icon.icns',
    'apps/desktop/build/icon.ico'
  ].map((relative) => ({ relative, absolute: path.join(root, relative), exists: existsSync(path.join(root, relative)) }));
}
