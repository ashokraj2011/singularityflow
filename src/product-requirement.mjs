/**
 * Teammates update themselves.
 *
 * An approved `singularity/product.yml` says which build a repository needs and where its signed
 * release lives:
 *
 *   schemaVersion: 1
 *   minimumBuild:
 *     builtAt: 2026-09-28T10:00:00.000Z
 *     commit: <the release's source commit>        # optional
 *   release:
 *     source: https://releases.example.com/singularity-flow/current/   # or an absolute shared folder
 *     artifactPublicKey: |
 *       -----BEGIN PUBLIC KEY-----
 *       ...
 *
 * A mutation in that repository on an older build installs the release first. The release must be
 * signed by the key the reviewed file carries, which is the organisation's trust channel: never a
 * key shipped beside the release. It is installed on every surface through the transactional
 * distribution installer, and the command continues on the new build. The file is honoured only
 * when it comes from an approved configuration authority, because it names both what to install
 * and the key that authorises it; a working-tree copy authorises nothing.
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { inspectNpmTarballBuildSources } from '../scripts/install-staged-artifacts.mjs';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { applyLocalReinstall, prepareDistributionInstall } from './reinstall.mjs';
import {
  compareBuilds, parseBuildLine, parseStampedBuildInfo, stampedBuildLine
} from './product-alignment.mjs';
import { PRODUCT_ALIGNMENT_SWITCH } from './product-alignment-gate.mjs';
import { priorRequirementCheck, PRODUCT_UPDATE_SWITCH, requirementChecksFile } from './product-requirement-gate.mjs';
import { withRegistryFileLease } from './file-lease.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { commandExists, run, SingularityFlowError } from './util.mjs';

export const PRODUCT_REQUIREMENT_FILE = 'singularity/product.yml';
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SMALL_BYTES = 16 * 1024 * 1024;
const ARTIFACT_BYTES = 512 * 1024 * 1024;

function invalid(message) {
  return new SingularityFlowError(`${PRODUCT_REQUIREMENT_FILE} is invalid: ${message}`, {
    code: 'PRODUCT_REQUIREMENT_INVALID'
  });
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be a mapping.`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw invalid(`${label} has unknown field(s): ${unknown.join(', ')}.`);
  const missing = required.filter((key) => value[key] == null);
  if (missing.length) throw invalid(`${label} is missing ${missing.join(', ')}.`);
}

export function parseProductRequirement(text) {
  let parsed;
  try { parsed = YAML.parse(String(text)); }
  catch (error) { throw invalid(`it is not YAML (${error.message}).`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('the file must be a mapping.');
  // A file a newer build wrote is refused as such, and the refusal is guided to product alignment.
  const { record: value } = readRecord('product-requirement', parsed);
  exactKeys(value, ['schemaVersion', 'minimumBuild', 'release'], [], 'the file');
  exactKeys(value.minimumBuild, ['builtAt'], ['commit'], 'minimumBuild');
  const builtAt = value.minimumBuild.builtAt instanceof Date
    ? value.minimumBuild.builtAt.toISOString() : String(value.minimumBuild.builtAt);
  if (!Number.isFinite(Date.parse(builtAt))) throw invalid('minimumBuild.builtAt must be an ISO-8601 instant.');
  const commit = value.minimumBuild.commit == null ? null : String(value.minimumBuild.commit);
  if (commit != null && !/^[0-9a-f]{40,64}$/u.test(commit)) throw invalid('minimumBuild.commit must be a full commit.');
  exactKeys(value.release, ['source', 'artifactPublicKey'], [], 'release');
  const source = String(value.release.source).trim();
  if (!path.isAbsolute(source)) {
    let url;
    try { url = new URL(source); } catch { throw invalid('release.source must be an https URL or an absolute folder.'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw invalid('release.source must be an https URL without credentials, or an absolute folder.');
    }
  }
  const artifactPublicKey = String(value.release.artifactPublicKey);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(artifactPublicKey.trim() + '\n')) {
    throw invalid('release.artifactPublicKey must be one PEM public key.');
  }
  return Object.freeze({
    minimumBuild: Object.freeze({ builtAt: new Date(builtAt).toISOString(), commit }),
    release: Object.freeze({ source, artifactPublicKey: `${artifactPublicKey.trim()}\n` })
  });
}

/** Whether this build meets a requirement. A development checkout is never updated. */
export function productRequirementVerdict(requirement, info = BUILD_INFO) {
  if (!info?.commit && !info?.sourceSha256) return 'development';
  if (requirement.minimumBuild.commit && info.commit === requirement.minimumBuild.commit) return 'satisfied';
  const running = Date.parse(info.builtAt ?? '');
  if (!Number.isFinite(running)) return 'unknown';
  return running >= Date.parse(requirement.minimumBuild.builtAt) ? 'satisfied' : 'update-required';
}

/**
 * The requirement in the repository's approved configuration, with the authority it came from, or
 * null when there is none. A working-tree fallback is not an authority and yields null.
 */
export async function readApprovedProductRequirement(root, { read = withApprovedConfigurationRead } = {}) {
  return read(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree' || !/^[0-9a-f]{40,64}$/u.test(String(authority.commit ?? ''))) {
      return null;
    }
    const file = path.join(configurationReadRoot(root), PRODUCT_REQUIREMENT_FILE);
    const text = await readFile(file, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (text == null) return null;
    return Object.freeze({
      requirement: parseProductRequirement(text),
      authority: Object.freeze({ kind: authority.kind, ref: authority.ref ?? null, commit: authority.commit })
    });
  }, { preferAuthority: true, allowLocalHeads: false });
}

/**
 * How long a release download may take. It runs before the command it precedes, so a stalled or
 * endless server must fail it, never hang it: a file that sends nothing for `idleMs`, or is not
 * complete within its total budget, is abandoned.
 */
export const RELEASE_DOWNLOAD_LIMITS = Object.freeze({
  idleMs: 30_000, smallTotalMs: 60_000, artifactTotalMs: 20 * 60_000
});

async function fetchReleaseFile(fetchImpl, base, name, limit, directory, {
  artifact = false, limits = RELEASE_DOWNLOAD_LIMITS
} = {}) {
  const url = new URL(name, base);
  const unavailable = (message) => new SingularityFlowError(message, { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
  const tooLarge = () => unavailable(`The release file ${name} has an unsupported size.`);
  const controller = new AbortController();
  const late = () => unavailable(`The release file ${name} did not arrive in time.`);
  const total = setTimeout(() => controller.abort(), artifact ? limits.artifactTotalMs : limits.smallTotalMs);
  let idle;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), limits.idleMs); };
  try {
    arm();
    let response;
    try { response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal }); }
    catch (error) {
      throw controller.signal.aborted ? late()
        : unavailable(`The release file ${name} could not be downloaded (${error?.message ?? error}).`);
    }
    if (new URL(response.url || url.href).protocol !== 'https:') {
      throw unavailable(`The release file ${name} was redirected away from https.`);
    }
    if (!response.ok) {
      throw unavailable(`The release file ${name} could not be downloaded (HTTP ${response.status}).`);
    }
    // Refuse an oversized file before reading it, and never hold more than the limit in memory.
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw tooLarge();
    let bytes;
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      let received = 0;
      try {
        for await (const chunk of response.body) {
          arm();
          received += chunk.length;
          if (received > limit) {
            controller.abort();
            throw tooLarge();
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error instanceof SingularityFlowError) throw error;
        throw controller.signal.aborted ? late()
          : unavailable(`The release file ${name} was interrupted (${error?.message ?? error}).`);
      }
      bytes = Buffer.concat(chunks, received);
    } else {
      // A fetch without a readable stream, such as a test double, is held to the same limits after reading.
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length < 1 || bytes.length > limit) throw tooLarge();
    await writeFile(path.join(directory, name), bytes, { mode: 0o600 });
    return bytes;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

/**
 * A local directory holding the promoted release. A shared folder is used as it is; an https
 * source is copied, file by file as its RELEASE.json names them, into a private directory. Nothing
 * here is trusted yet: the distribution installer verifies every byte against the pinned key.
 */
export async function materializeRelease(source, {
  fetchImpl = globalThis.fetch, tempRoot = os.tmpdir(), limits = RELEASE_DOWNLOAD_LIMITS
} = {}) {
  if (path.isAbsolute(source)) {
    const info = await lstat(source).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new SingularityFlowError(`The release folder is not an ordinary directory: ${source}`, { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
    }
    return Object.freeze({ directory: source, temporary: null });
  }
  if (typeof fetchImpl !== 'function') {
    throw new SingularityFlowError('This Node.js runtime cannot download a release.', { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
  }
  const base = new URL(source.endsWith('/') ? source : `${source}/`);
  const directory = await mkdtemp(path.join(tempRoot, 'sflow-release-'));
  try {
    const release = JSON.parse((await fetchReleaseFile(fetchImpl, base, 'RELEASE.json', SMALL_BYTES, directory, { limits })).toString('utf8'));
    const named = [
      ...(release.artefacts ?? []), ...(release.operatorScripts ?? []), ...(release.operatorDocumentation ?? [])
    ];
    if (!named.length || named.some((name) => typeof name !== 'string' || !RELEASE_NAME.test(name))) {
      throw new SingularityFlowError('The release RELEASE.json names an unsupported file.', { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
    }
    for (const name of ['SHA256SUMS', 'ARTIFACT-RECEIPT.json']) {
      await fetchReleaseFile(fetchImpl, base, name, SMALL_BYTES, directory, { limits });
    }
    for (const name of new Set(named)) {
      const artifact = /\.(tgz|vsix)$/u.test(name);
      await fetchReleaseFile(fetchImpl, base, name, artifact ? ARTIFACT_BYTES : SMALL_BYTES, directory, { artifact, limits });
    }
    return Object.freeze({ directory, temporary: directory });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The identity a `--build` line names: its full commit or source digest, and its stamp instant. */
function buildLineIdentity(parsed) {
  if (!parsed?.stamped) return null;
  const first = (/^[^\s()]+ \((.+)\)$/u.exec(parsed.line)?.[1] ?? '').split(' · ')[0];
  return Object.freeze({
    commit: /^[0-9a-f]{40,64}$/u.test(first) ? first : null,
    sourceSha256: first.startsWith('source ') ? first.slice('source '.length) : null,
    builtAt: parsed.builtAt
  });
}

/** The build `singularity-flow` on PATH runs, or null. Never throws. */
function pathCliBuild({ execute, environment }) {
  try {
    const result = execute('singularity-flow', ['--build'], {
      allowFailure: true, timeoutMs: 30_000,
      env: { ...environment, [PRODUCT_UPDATE_SWITCH]: 'off', [PRODUCT_ALIGNMENT_SWITCH]: 'off' }
    });
    if (result?.status !== 0 || result.timedOut || result.error) return null;
    return parseBuildLine(result.stdout);
  } catch {
    return null;
  }
}

/** The one npm tarball a release's RELEASE.json names. Nothing in the release is trusted yet. */
async function releaseTarball(directory) {
  const file = path.join(directory, 'RELEASE.json');
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > SMALL_BYTES) {
    throw new SingularityFlowError('The release has no readable RELEASE.json.', { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
  }
  let release;
  try { release = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new SingularityFlowError('The release RELEASE.json is not JSON.', { code: 'PRODUCT_RELEASE_UNAVAILABLE' }); }
  const tarballs = (Array.isArray(release?.artefacts) ? release.artefacts : [])
    .filter((name) => typeof name === 'string' && RELEASE_NAME.test(name) && name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new SingularityFlowError('The release RELEASE.json must name exactly one npm tarball.', { code: 'PRODUCT_RELEASE_UNAVAILABLE' });
  }
  return path.join(directory, tarballs[0]);
}

/**
 * The build a release installs, read from the stamp inside its npm tarball: the bytes that become
 * the CLI, never a name written beside them.
 */
async function releaseBuild(tarball) {
  let inspected;
  try { inspected = await inspectNpmTarballBuildSources(tarball); }
  catch (error) {
    throw new SingularityFlowError(`The release's npm tarball has no readable build stamp (${error.message}).`, {
      code: 'PRODUCT_RELEASE_UNSTAMPED'
    });
  }
  const info = parseStampedBuildInfo(inspected.buildInfoSource);
  const build = stampedBuildLine(inspected.versionSource, inspected.buildInfoSource);
  if (!info || !build?.stamped) {
    throw new SingularityFlowError("The release's npm tarball is not a stamped build.", { code: 'PRODUCT_RELEASE_UNSTAMPED' });
  }
  return Object.freeze({ info, build });
}

/**
 * A release is installed only when it meets the requirement and is not older than the build it
 * replaces. Without this, a requirement raised before its release was published would install the
 * same unsatisfying release again on every command, and an older one would downgrade the machine.
 */
function assertReleaseInstallable(requirement, offered, running) {
  if (productRequirementVerdict(requirement, offered.info) !== 'satisfied') {
    throw new SingularityFlowError(
      `The release at ${requirement.release.source} is ${offered.build.line}, which does not meet the build from `
      + `${requirement.minimumBuild.builtAt} this repository requires. Nothing was installed; publish the required build there.`,
      { code: 'PRODUCT_RELEASE_BELOW_REQUIREMENT' }
    );
  }
  const current = parseBuildLine(versionLine(running));
  if (compareBuilds(offered.build, current) === -1) {
    throw new SingularityFlowError(
      `The release at ${requirement.release.source} is ${offered.build.line}, older than the running ${current.line}. `
      + 'Nothing was installed: an update never downgrades.',
      { code: 'PRODUCT_RELEASE_DOWNGRADE' }
    );
  }
}

/**
 * The installer's own commands write to stderr. Stdout belongs to the command this update precedes,
 * whose `--json` result a caller such as VS Code parses; npm's summary there would corrupt it.
 */
function toStandardError(execute) {
  return (command, args, options = {}) => execute(command, args,
    options?.stdio === 'inherit' ? { ...options, stdio: ['inherit', 2, 2] } : options);
}

/**
 * Install the required release on every surface through the distribution installer, with the
 * confirmation the reviewed requirement already gave. The installer verifies the signature,
 * snapshots rollback bytes, and restores every touched surface if any step fails.
 */
export async function installRequiredRelease(requirement, {
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  running = BUILD_INFO,
  tempRoot = os.tmpdir(),
  fetchImpl = globalThis.fetch,
  prepare = prepareDistributionInstall,
  apply = applyLocalReinstall
} = {}) {
  const release = await materializeRelease(requirement.release.source, { fetchImpl, tempRoot });
  const keyDirectory = await mkdtemp(path.join(tempRoot, 'sflow-release-key-'));
  execute = toStandardError(execute);
  try {
    // Refuse a release that cannot satisfy the requirement before the installer stages anything.
    assertReleaseInstallable(requirement, await releaseBuild(await releaseTarball(release.directory)), running);
    const artifactKey = path.join(keyDirectory, 'artifact-builder-public.pem');
    await writeFile(artifactKey, requirement.release.artifactPublicKey, { mode: 0o600 });
    const plan = await prepare({
      releaseDirectory: release.directory, artifactKey,
      cliOnly: !exists('code') || !exists('copilot'),
      execute, exists, homeDirectory, environment, tempRoot
    });
    // Judge again the verified snapshot the installer activates: a shared folder can change after
    // the first look, and only these bytes carry the pinned key's signature.
    assertReleaseInstallable(requirement, await releaseBuild(plan.bundle.tarball), running);
    const applied = await apply(plan, {
      confirmation: plan.confirmation, execute, exists, homeDirectory, environment
    });
    return Object.freeze({ status: 'installed', version: plan.version, fingerprint: plan.fingerprint, applied });
  } finally {
    await rm(keyDirectory, { recursive: true, force: true });
    if (release.temporary) await rm(release.temporary, { recursive: true, force: true });
  }
}

/** Merge one repository's verdict into the record. Writers are serialized, so no verdict is lost. */
async function recordRequirementVerdict(homeDirectory, root, entry) {
  const file = requirementChecksFile(homeDirectory);
  const key = await realpath(root).catch(() => path.resolve(root));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withRegistryFileLease(file, async () => {
    let repositories = {};
    try { repositories = JSON.parse(await readFile(file, 'utf8'))?.repositories ?? {}; } catch { repositories = {}; }
    repositories[key] = entry;
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: currentSchemaVersion('product-requirement-checks'), repositories
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    await chmod(file, 0o600);
  });
}

/**
 * Before a mutation: install the build this repository's approved configuration requires, when
 * this build is older, and hand the command to it. Never fails the command: if the release cannot
 * be read or installed, the command continues on this build with one line saying what to run.
 */
export async function enforceProductRequirement({
  root,
  runningBuild,
  argv,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  write = (line) => process.stderr.write(`${line}\n`),
  read = readApprovedProductRequirement,
  install = installRequiredRelease,
  pathBuild = pathCliBuild,
  info = BUILD_INFO,
  now = () => new Date().toISOString()
} = {}) {
  const prior = await priorRequirementCheck({ homeDirectory, root });
  const record = (verdict, extra = {}) => recordRequirementVerdict(homeDirectory, root, {
    build: runningBuild, checkedAt: now(), verdict, requirement: verdict !== 'none', ...extra
  }).catch(() => undefined);
  let found;
  try { found = await read(root); }
  catch (error) {
    // Most repositories carry no requirement, and one whose approved configuration cannot be read
    // here fails loudly in the commands that need it. Say so only where a requirement is known.
    const known = prior?.requirement === true
      || Boolean((await lstat(path.join(root, PRODUCT_REQUIREMENT_FILE)).catch(() => null))?.isFile());
    if (known) write(`Singularity Flow could not read this repository's approved product requirement: ${error.message}`);
    await record('unavailable', {
      requirement: known, code: error?.code ?? null, reason: String(error?.message ?? error).slice(0, 500)
    });
    return Object.freeze({ status: 'unavailable' });
  }
  if (!found) {
    await record('none');
    return Object.freeze({ status: 'none' });
  }
  const verdict = productRequirementVerdict(found.requirement, info);
  const requirement = found.requirement;
  if (verdict !== 'update-required') {
    await record(verdict, { authorityCommit: found.authority.commit });
    return Object.freeze({ status: verdict });
  }
  const handOff = () => {
    const handed = execute('singularity-flow', argv, {
      stdio: 'inherit', allowFailure: true,
      env: { ...environment, [PRODUCT_UPDATE_SWITCH]: 'off', [PRODUCT_ALIGNMENT_SWITCH]: 'off' }
    });
    return Object.freeze({ status: 'handed-off', exitCode: Number.isInteger(handed.status) ? handed.status : 1 });
  };
  // The machine may already run the required build on PATH while this process is older: a VS Code
  // window keeps its bundled CLI until it reloads. Installing again would repeat on every command.
  const onPath = pathBuild({ execute, environment });
  const onPathIdentity = buildLineIdentity(onPath);
  if (onPathIdentity && productRequirementVerdict(requirement, onPathIdentity) === 'satisfied') {
    write(`Singularity Flow: this repository requires a build from ${requirement.minimumBuild.builtAt} or later; continuing this command on the installed ${onPath.line}.`);
    return handOff();
  }
  write(`Singularity Flow: this repository requires a build from ${requirement.minimumBuild.builtAt} or later. Installing its signed release from ${requirement.release.source}.`);
  try {
    await install(requirement, { execute, exists, homeDirectory, environment, running: info });
  } catch (error) {
    write(`Singularity Flow could not install the required release (${error.message}). Install it with the release's own wrapper: ${requirement.release.source}. Continuing on this build.`);
    await record('failed', {
      authorityCommit: found.authority.commit, required: requirement.minimumBuild.builtAt,
      code: error?.code ?? null, reason: String(error?.message ?? error).slice(0, 500)
    });
    return Object.freeze({ status: 'failed' });
  }
  await record('installed', { authorityCommit: found.authority.commit, required: requirement.minimumBuild.builtAt });
  write('Singularity Flow: continuing this command on the required build.');
  return handOff();
}

