/** Compiled immutable configuration, not a cache of permissions, refs or application state. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { BUILD_INFO } from './build-info.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { gitCommonDir } from './git.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar, writeMutablePrivateSidecar } from './private-sidecar.mjs';

const FORMAT = 1;
const MAXIMUM_BYTES = 8 * 1024 * 1024;
let engineIdentity;
const privacy = { enforceWindowsAcl: true };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function configurationEngineIdentity() {
  engineIdentity ??= (async () => {
    // Production packages have an exact build stamp. Development trees must use content, not
    // mtimes: a same-size restored-time edit to a validator must invalidate its old receipts.
    const hash = createHash('sha256');
    if (!BUILD_INFO.dirty && (BUILD_INFO.sourceSha256 || BUILD_INFO.commit)) {
      hash.update(JSON.stringify(BUILD_INFO));
    } else {
      let files = 0, total = 0;
      const visit = async (relative) => {
        for (const entry of (await readdir(path.join(PACKAGE_ROOT, relative), { withFileTypes: true }))
          .sort((a, b) => a.name.localeCompare(b.name))) {
          const file = path.posix.join(relative, entry.name);
          if (entry.isSymbolicLink()) throw new Error('Unqualified engine cache identity');
          if (entry.isDirectory()) await visit(file);
          else if (entry.isFile()) {
            if (++files > 5_000) throw new Error('Engine cache inventory exceeded');
            const bytes = await readFile(path.join(PACKAGE_ROOT, file));
            if ((total += bytes.length) > 64 * 1024 * 1024) throw new Error('Engine cache bytes exceeded');
            hash.update(file).update('\0').update(digest(bytes)).update('\0');
          }
        }
      };
      await visit('src');
    }
    // Packaged templates and agent fallbacks are inputs too, including optional packs absent
    // from the approved tree. A build stamp does not stand in for this dependency membership.
    let packagedFiles = 0, packagedBytes = 0;
    const packaged = async relative => {
      for (const entry of (await readdir(path.join(PACKAGE_ROOT, relative), { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await packaged(file);
        else if (entry.isFile()) {
          const bytes = await readFile(path.join(PACKAGE_ROOT, file));
          if (++packagedFiles > 5_000 || (packagedBytes += bytes.length) > 32 * 1024 * 1024) throw new Error('Packaged cache identity exceeded');
          hash.update(file).update('\0').update(digest(bytes));
        } else throw new Error('Unqualified packaged cache identity');
      }
    };
    await packaged('plugin/agents');
    await packaged('templates');
    await packaged('schemas');
    hash.update(await readFile(path.join(PACKAGE_ROOT, 'package.json')));
    hash.update(await readFile(path.join(PACKAGE_ROOT, 'package-lock.json')).catch(error => {
      if (error.code === 'ENOENT') return Buffer.from('no-packaged-lock');
      throw error;
    }));
    return hash.digest('hex');
  })();
  return engineIdentity;
}

/** Preserve runtime-only root descriptors and isolate every consumer's mutable normalization. */
export function copyCompiledDefinition(definition, from, to) {
  const copy = structuredClone(definition);
  for (const key of ['initiativeRoot', 'governedRoots']) {
    if (Object.hasOwn(definition, key)) Object.defineProperty(copy, key, {
      value: structuredClone(definition[key]), enumerable: false
    });
  }
  for (const agent of copy.agentCatalog ?? []) {
    if (agent.scope === 'repository') {
      const relative = path.relative(from, agent.file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Compiled agent escaped its configuration root');
      }
      agent.file = path.join(to, relative);
    }
    agent.source = path.relative(to, agent.file).split(path.sep).join('/');
    if (copy.agents?.[agent.id]) copy.agents[agent.id] = agent;
  }
  return copy;
}

/** One replaceable receipt per exact object store: build upgrades cannot grow an unbounded cache. */
export async function compiledConfiguration(root, configurationRoot, assets, compile, { env = process.env } = {}) {
  if (!root || env.SINGULARITY_FLOW_COMPILED_CONFIGURATION_CACHE === 'off') return compile();
  let directory, key;
  try {
    directory = path.join(gitCommonDir(root), 'singularity-flow', 'compiled-configuration-v1');
    const rows = assets.map(({ relative, sha256, gitMode }) => [relative, sha256, gitMode])
      .sort((a, b) => a[0].localeCompare(b[0]));
    key = digest(JSON.stringify([FORMAT, await configurationEngineIdentity(), rows]));
  } catch { return compile(); }
  const secretFile = path.join(directory, 'key');
  const receiptFile = path.join(directory, 'definition.v8');
  let secret = null;
  const loadSecret = () => readPrivateSidecar(root, secretFile, { ...privacy, maximumBytes: 32, optional: true });
  try {
    secret = await loadSecret();
    const receipt = await readPrivateSidecar(root, receiptFile, { ...privacy, maximumBytes: MAXIMUM_BYTES, optional: true });
    if (secret?.length === 32 && receipt?.length > 32) {
      const data = receipt.subarray(32);
      const mac = createHmac('sha256', secret).update(data).digest();
      if (timingSafeEqual(mac, receipt.subarray(0, 32))) {
        const decoded = deserialize(data);
        if (decoded.format === FORMAT && decoded.key === key) {
          const result = copyCompiledDefinition(decoded.definition, decoded.root, configurationRoot);
          for (const name of ['initiativeRoot', 'governedRoots']) {
            if (Object.hasOwn(decoded.derived, name)) Object.defineProperty(result, name, {
              value: structuredClone(decoded.derived[name]), enumerable: false
            });
          }
          incrementCommandCounter('configuration.compiled-hit');
          return result;
        }
      }
    }
  } catch { /* Corruption, version mismatch and unqualified privacy are cache misses, not authority. */ }
  incrementCommandCounter('configuration.compiled-miss');
  const definition = await measureCommandSpan('configuration.compile', compile);
  try {
    if (!secret) {
      try { await writeImmutablePrivateSidecar(root, secretFile, randomBytes(32), { ...privacy, maximumBytes: 32 }); }
      catch { /* A concurrent compiler may have installed its private key first. */ }
      secret = await loadSecret();
    }
    if (secret?.length !== 32) return definition;
    const derived = Object.fromEntries(['initiativeRoot', 'governedRoots']
      .filter(name => Object.hasOwn(definition, name)).map(name => [name, definition[name]]));
    const data = serialize({ format: FORMAT, key, root: configurationRoot, definition, derived });
    if (data.length + 32 <= MAXIMUM_BYTES) await writeMutablePrivateSidecar(root, receiptFile,
      Buffer.concat([createHmac('sha256', secret).update(data).digest(), data]), { ...privacy, maximumBytes: MAXIMUM_BYTES });
  } catch { /* A cache write must not deny an independently validated configuration. */ }
  return definition;
}
