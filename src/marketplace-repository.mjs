/**
 * A marketplace published as a Git repository with an APM manifest at its root [owner, 2026-11-21]: the agents and
 * skills its `marketplace.packages` list, each read straight from its own apm.yml (and its agent.md or SKILL.md) at
 * the one commit the configuration pins.
 *
 * APM 0.35 refuses a package of `type: agent` and drops every key it does not know (pdlc-phases, pdlc-tasks,
 * lifecycle-state), so neither `apm install` nor the APM CLI can list such a marketplace. SFlow reads the files
 * itself, through git.mjs: one ls-remote pins the commit (remoteRefCommit), and that commit alone is fetched into a
 * transient isolated object repository (withIsolatedGitObjectRepository). Read only: nothing is checked out, no hook
 * or filter of the other repository runs, and a link or submodule in it is refused. What a package says is data.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { CODEOWNERS_LIMITS, CODEOWNERS_PATHS, codeOwnersOf, parseCodeowners } from './codeowners.mjs';
import { commitShape, exactFileAtObject, exactTreePathsAtObject, remoteRefCommit, withIsolatedGitObjectRepository } from './git.mjs';
import { itemLifecycle, LIFECYCLE_LIMITS, LIFECYCLE_RECORD_FILE, lifecycleFindings, parseLifecycleRecord } from './marketplace-lifecycle.mjs';
import { ownerSummary, parseOwnerBlock, resolveOwner } from './marketplace-owner.mjs';
import { SingularityFlowError } from './util.mjs';

export const MARKETPLACE_MANIFEST = 'apm.yml';
export const MARKETPLACE_REPOSITORY_RESULT = 'marketplace-repository';
const LIMITS = Object.freeze({ packages: 500, manifestBytes: 256 * 1024, documentBytes: 512 * 1024, repositoryBytes: 64 * 1024 * 1024, text: 1000, list: 64, value: 120 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// A branch or tag name, as a trust's `ref` takes it (marketplace.mjs, which this module does not load).
const REF = /^(?![./-])(?!.*(?:\.\.|@\{|[~^:?*\\[]))(?!.*\/\.)(?!.*[/.]$)[^\s\u0000-\u001f\u007f]{1,200}$/u;
/** The channels a marketplace may publish, in v1, and the file beside its root apm.yml that declares them [OMK:REQ-004]. */
export const MARKETPLACE_CHANNELS = Object.freeze(['stable', 'beta']);
export const MARKETPLACE_CHANNELS_FILE = 'channels.yml';
const CHANNELS_FILE_BYTES = 64 * 1024;

function fail(message, code = 'MARKETPLACE_REPOSITORY_INVALID', details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

const oneLine = (value, max = LIMITS.text) => {
  if (value == null) return null;
  const result = String(value).replace(/\s+/gu, ' ').trim();
  return result ? result.slice(0, max) : null;
};
const values = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
  .map((entry) => oneLine(entry, LIMITS.value)).filter(Boolean).slice(0, LIMITS.list);

function parseYaml(text, label) {
  const document = YAML.parseDocument(text, { uniqueKeys: true, maxAliasCount: 50 });
  if (document.errors.length) throw fail(`${label} is not valid YAML: ${document.errors[0].message.split('\n')[0]}`);
  const value = document.toJS({ maxAliasCount: 50 });
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be a YAML mapping.`);
  return value;
}

/** A path inside the repository from a package's `source` (./agents/x) or a local dependency (../../skills/y). */
function inside(base, relative, label) {
  const raw = String(relative ?? '').trim();
  if (!raw || raw.includes('\0') || raw.includes('\\') || path.posix.isAbsolute(raw) || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) return null;
  const joined = path.posix.normalize(path.posix.join(base, raw)).replace(/\/+$/u, '');
  if (!joined || joined === '.' || joined.startsWith('../') || joined === '..') throw fail(`${label} points outside the repository: '${raw}'.`);
  return joined;
}

/**
 * The `channels:` mapping of channels.yml [OMK:REQ-004]: each channel v1 knows (stable, beta) as `{ ref, description,
 * after }`, with the problems of what is left out. Never a refusal: an older build never reads the file, and this one
 * leaves out what is wrong in it.
 */
export function parseMarketplaceChannels(value, { label = MARKETPLACE_CHANNELS_FILE } = {}) {
  const channels = {};
  const problems = [];
  if (value == null) return { channels, problems };
  if (typeof value !== 'object' || Array.isArray(value)) return { channels, problems: [`${label} channels is not a mapping, so no channel is read.`] };
  for (const [name, entry] of Object.entries(value)) {
    if (!MARKETPLACE_CHANNELS.includes(name)) { problems.push(`${label} names a channel '${String(name).slice(0, 40)}'; SFlow knows only stable and beta, so it is left out.`); continue; }
    const ref = typeof entry?.ref === 'string' ? entry.ref.trim() : '';
    if (!REF.test(ref)) { problems.push(`${label} channel ${name} has no ref that is a branch or tag name, so it is left out.`); continue; }
    channels[name] = { ref, description: oneLine(entry.description, 300), after: typeof entry.after === 'string' ? entry.after.trim() : null };
  }
  for (const [name, channel] of Object.entries(channels)) {
    if (channel.after && (!channels[channel.after] || channel.after === name)) {
      problems.push(`${label} channel ${name} moves after '${channel.after.slice(0, 40)}', which is not another of its channels, so it has no order.`);
      channel.after = null;
    }
  }
  return { channels, problems };
}

/**
 * A marketplace's channels.yml, beside its root apm.yml [OMK:REQ-004]: its top-level `channels:` mapping, read as
 * parseMarketplaceChannels reads it. They live in a file of their own because APM 0.35's `apm pack` refuses any key it
 * does not know in apm.yml's marketplace block (probe P1, 2026-11-26). YAML that cannot be read is one problem.
 */
export function parseChannelsFile(text, { label = MARKETPLACE_CHANNELS_FILE } = {}) {
  let value;
  try { value = YAML.parse(String(text ?? ''), { maxAliasCount: 50 }); } catch (error) {
    return { channels: {}, problems: [`${label} is not valid YAML, so no channel is read: ${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`] };
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return { channels: {}, problems: [`${label} is not a mapping with a channels key, so no channel is read.`] };
  return parseMarketplaceChannels(value.channels, { label });
}

/** The finding for channels left in apm.yml's marketplace block, which is no longer read there [OMK:REQ-004]. */
export function misplacedChannelsFinding(label = MARKETPLACE_MANIFEST) {
  return { class: 'marketplace-channels-misplaced', owner: 'marketplace',
    words: `${label} declares marketplace.channels, which SFlow does not read there: APM 0.35's apm pack refuses that key, so the channels belong in ${MARKETPLACE_CHANNELS_FILE} beside ${label}.`,
    fix: `Move the channels from ${label}'s marketplace block into ${MARKETPLACE_CHANNELS_FILE} beside it, under a top-level channels key.` };
}

/** The channel a trust reads: the one whose ref is the trust's own `ref` at the commit it is pinned to [OMK:REQ-021]. */
export function trustChannel(channels = {}, ref = null) {
  if (!ref) return null;
  return MARKETPLACE_CHANNELS.find((name) => channels?.[name]?.ref === ref) ?? null;
}

/**
 * The root apm.yml of a marketplace: its name and description, the owner, and each listed package
 * `{ name, description, source, includePrerelease }`. A package without a local `source` is listed as it is, with a
 * problem: this reads only what the repository itself holds. Channels are channels.yml's (parseChannelsFile); a
 * `marketplace.channels` key here is not read, and `misplacedChannels` says it is there.
 */
export function parseMarketplaceManifest(text, { label = MARKETPLACE_MANIFEST } = {}) {
  const manifest = parseYaml(text, label);
  const block = manifest.marketplace;
  if (!block || typeof block !== 'object' || !Array.isArray(block.packages)) {
    throw fail(`${label} has no marketplace block listing packages (marketplace.packages), so this repository is not a marketplace.`, 'MARKETPLACE_REPOSITORY_NOT_MARKETPLACE');
  }
  if (block.packages.length > LIMITS.packages) throw fail(`${label} lists more than ${LIMITS.packages} packages.`);
  const seen = new Set();
  const packages = block.packages.map((entry, index) => {
    const at = `${label} marketplace.packages[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(`${at} must be a mapping with a name and a source.`);
    const name = oneLine(entry.name, 100);
    if (!name) throw fail(`${at} has no name.`);
    if (seen.has(name)) throw fail(`${label} lists package '${name}' twice.`);
    seen.add(name);
    const source = typeof entry.source === 'string' ? inside('.', entry.source, at) : null;
    return { name, description: oneLine(entry.description), source, includePrerelease: entry.include_prerelease === true,
      ...(source ? {} : { problem: `${name} has no source folder in this repository, so it is not read.` }) };
  });
  return {
    name: oneLine(manifest.name, 120), description: oneLine(manifest.description), version: oneLine(manifest.version, 64),
    owner: oneLine(block.owner?.name ?? block.owner, 200), ownerEmail: oneLine(block.owner?.email, 200),
    misplacedChannels: Object.hasOwn(block, 'channels'), packages
  };
}

const KINDS = Object.freeze({ agent: 'agent', skill: 'skill', instructions: 'instructions', prompts: 'prompt', prompt: 'prompt', hybrid: 'hybrid' });

/**
 * One package's own apm.yml, as SFlow reads it: `type` (agent, skill, ...) and the keys APM 0.35 does not know
 * (pdlc-phases, pdlc-tasks, lifecycle-state), read here because APM drops them. Local dependencies
 * (`dependencies.apm: [../../skills/x]`) are resolved against the package's folder; any other is named as it is.
 */
export function parsePackageManifest(text, { source, label = `${source}/${MARKETPLACE_MANIFEST}` } = {}) {
  const manifest = parseYaml(text, label);
  const type = oneLine(manifest.type, 40);
  const listed = Array.isArray(manifest.dependencies?.apm) ? manifest.dependencies.apm.slice(0, LIMITS.list) : [];
  const dependencies = listed.map((entry) => {
    const raw = typeof entry === 'string' ? entry : typeof entry?.path === 'string' ? entry.path : null;
    if (!raw) return { reference: oneLine(JSON.stringify(entry), 200), path: null };
    const local = /^\.\.?\//u.test(raw.trim()) ? inside(source, raw, label) : null;
    return { reference: raw.trim(), path: local };
  });
  return {
    name: oneLine(manifest.name, 100), version: oneLine(manifest.version, 64), description: oneLine(manifest.description), type,
    kind: KINDS[type] ?? (type ? 'other' : 'unknown'),
    lifecycleState: oneLine(manifest['lifecycle-state'], 40),
    pdlcPhases: values(manifest['pdlc-phases']), pdlcTasks: values(manifest['pdlc-tasks']),
    tags: values(manifest.tags), categories: values(manifest.categories), dependencies,
    // Who to tell about it, and where its own issues go: the conversion review's feedback is addressed to them (MCR §6).
    maintainer: oneLine(manifest['maintainer-email'] ?? manifest.maintainer, 200) || null,
    sourceRepository: oneLine(manifest['source-repository'], 500) || null,
    // OMK §4.1, §4.2: its owner block and a lifecycle mapping, read as data; resolved with the rest in packageMetadata.
    ownerBlock: manifest.owner ?? null,
    lifecycleMapping: manifest.lifecycle && typeof manifest.lifecycle === 'object' && !Array.isArray(manifest.lifecycle) ? manifest.lifecycle : null
  };
}

/**
 * One package's owner, lifecycle and the marketplace-owned findings on them [OMK:REQ-001, REQ-002, REQ-003, REQ-013],
 * from what the repository holds at the commit read: its apm.yml (`own`, parsePackageManifest), its lifecycle.yml's text
 * (`lifecycleText`, or null), the marketplace's CODEOWNERS (`codeowners`, parseCodeowners, or null) and owner, and the
 * commit's own day. `{ owner, lifecycleRecord, findings }`. Pure.
 */
export function packageMetadata({ name, source, own, lifecycleText = null, codeowners = null, marketplaceOwner = null, commitDate = null }) {
  const findings = [];
  const block = parseOwnerBlock(own.ownerBlock ?? null, { name });
  findings.push(...block.findings);
  const folderOwners = codeowners ? codeOwnersOf(codeowners, `${source}/${MARKETPLACE_MANIFEST}`).owners : null;
  const owner = resolveOwner({ own: block.owner, folderOwners, maintainer: own.maintainer ?? null, marketplaceOwner });
  let file = null;
  if (lifecycleText != null) {
    try {
      const value = YAML.parse(lifecycleText, { maxAliasCount: 50 });
      file = parseLifecycleRecord(value);
      if (!file) throw new Error('it is not a mapping');
    } catch (error) {
      findings.push({ class: 'marketplace-lifecycle-record', owner: 'marketplace', item: name,
        words: `${name}'s ${LIFECYCLE_RECORD_FILE} cannot be read (${String(error?.message ?? error).split('\n')[0].slice(0, 120)}), so its apm.yml's lifecycle is used.`,
        fix: `Write ${name}'s ${LIFECYCLE_RECORD_FILE} as a YAML mapping with state and history.` });
      file = null;
    }
  }
  const mapping = file ? null : parseLifecycleRecord(own.lifecycleMapping);
  const recordFile = file ? `${source}/${LIFECYCLE_RECORD_FILE}` : `${source}/${MARKETPLACE_MANIFEST}`;
  const guard = codeowners ? codeOwnersOf(codeowners, recordFile) : { covered: false, owners: [] };
  const lifecycle = itemLifecycle({ file, mapping, state: own.lifecycleState, tags: own.tags, guard, owner });
  findings.push(...lifecycleFindings({ name, parsed: file ?? mapping, lifecycle, file: LIFECYCLE_RECORD_FILE, apmState: own.lifecycleState, commitDate }));
  if (owner?.confirmed === false) {
    findings.push({ class: 'marketplace-owner-unconfirmed', owner: 'marketplace', item: name,
      words: `${name}'s apm.yml names ${owner.handle} as its owner, but CODEOWNERS names ${folderOwners.join(', ')} for its folder.`,
      fix: `Make ${owner.handle} the code owner of ${source}/ in CODEOWNERS, or name the team CODEOWNERS names in ${name}'s owner block.` });
  }
  return { owner: owner ? { ...ownerSummary(owner), feedbackLabels: [...owner.feedbackLabels] } : null, lifecycleRecord: lifecycle, findings };
}

const decode = (bytes, label) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw fail(`${label} is not UTF-8 text.`); }
};

/** The document a package's kind is written in: agent.md (or one *.agent.md) for an agent, SKILL.md for a skill. */
function documentOf(kind, folder, files) {
  const own = files.filter((file) => path.posix.dirname(file) === folder).map((file) => path.posix.basename(file));
  if (kind === 'agent') return own.includes('agent.md') ? `${folder}/agent.md` : own.filter((name) => name.endsWith('.agent.md')).length === 1
    ? `${folder}/${own.find((name) => name.endsWith('.agent.md'))}` : null;
  if (kind === 'skill') return own.includes('SKILL.md') ? `${folder}/SKILL.md` : null;
  return null;
}

/**
 * Read a repository marketplace `{ id, repository, ref, commit }` at its commit (or, with no commit, at `ref`'s tip):
 * `{ repository, ref, commit, name, description, owner, channels, channel, codeowners, packages, problems, findings }`,
 * `channels` from its channels.yml and `findings` the marketplace's own on its root files. Each package is
 * `{ name, kind, type, version, description, lifecycleState, pdlcPhases, pdlcTasks, tags, categories, source,
 * includePrerelease, skills, dependencies, document }`, where `skills` are the listed skill packages it depends on.
 * `documents` names the packages whose agent.md or SKILL.md text is returned (`text`), or is a function of the
 * packages that returns those names; the others carry only the document's path.
 */
function unreachableMarketplace(marketplace, reason, details = {}) {
  const label = marketplace.id ? `Marketplace '${marketplace.id}'` : 'The marketplace';
  const where = marketplace.commit ? `at commit ${marketplace.commit.slice(0, 12)}` : marketplace.ref ? `at ${marketplace.ref}` : 'at its default branch';
  return fail(`${label} (${marketplace.repository}) cannot be read ${where}: ${reason} Check that this computer can reach it with Git (as a git clone of it would), then run the same command again.`,
    'MARKETPLACE_REPOSITORY_UNREACHABLE', { repository: marketplace.repository, ref: marketplace.ref ?? null, commit: marketplace.commit ?? null, ...details });
}

/**
 * The commit a repository marketplace's `ref` (else its default branch) is at now: one ls-remote, nothing fetched. What
 * reading it with no commit reads (`marketplace add --repo`, `imports check`'s newest commit), and what `marketplace
 * catalog --newest` compares with the commit the repository trusts.
 */
export async function newestMarketplaceCommit(marketplace) {
  const label = marketplace.id ? `Marketplace '${marketplace.id}'` : 'The marketplace';
  const resolved = await remoteRefCommit(marketplace.repository, marketplace.ref ?? null);
  const stderr = String(resolved.result?.stderr ?? '').trim().split(/\r?\n/u).slice(-1)[0]?.slice(0, 200);
  if (resolved.ambiguous) {
    throw fail(`${label}: '${marketplace.ref}' is both a branch and a tag there, at different commits. Use --ref with a name only one of them has.`,
      'MARKETPLACE_REPOSITORY_REF_AMBIGUOUS', { repository: marketplace.repository, ref: marketplace.ref });
  }
  if (!resolved.commit) {
    throw unreachableMarketplace({ ...marketplace, commit: null }, resolved.result?.status === 0
      ? `it has no ${marketplace.ref ? `branch or tag '${marketplace.ref}'` : 'default branch'}.` : `Git said: ${stderr || 'nothing'}.`, { stage: 'resolve' });
  }
  return resolved.commit;
}

export async function readMarketplaceRepository(marketplace, { documents = [] } = {}) {
  const label = marketplace.id ? `Marketplace '${marketplace.id}'` : 'The marketplace';
  const unreachable = (reason, details = {}) => unreachableMarketplace(marketplace, reason, details);
  const pinned = marketplace.commit ?? await newestMarketplaceCommit(marketplace);
  let snapshot;
  try {
    snapshot = await withIsolatedGitObjectRepository({ remote: marketplace.repository, expectedCommit: pinned, executables: true, maximumBytes: LIMITS.repositoryBytes }, (root) => {
      const commit = pinned;
      const read = (file, maximumBytes) => {
        const bytes = exactFileAtObject(root, commit, file, { maximumBytes, regularOnly: true });
        return bytes ? decode(bytes, file) : null;
      };
      const rootText = read(MARKETPLACE_MANIFEST, LIMITS.manifestBytes);
      if (rootText == null) {
        throw fail(`${label} has no ${MARKETPLACE_MANIFEST} at its root at ${commit.slice(0, 12)} (or it is larger than 256 KiB), so it is not a marketplace.`,
          'MARKETPLACE_REPOSITORY_NOT_MARKETPLACE');
      }
      const manifest = parseMarketplaceManifest(rootText);
      const files = exactTreePathsAtObject(root, commit, []) ?? [];
      const problems = manifest.packages.filter((entry) => entry.problem).map((entry) => entry.problem);
      // The channels, from channels.yml beside apm.yml [OMK:REQ-004]; one left in apm.yml is a finding, and the read goes on.
      const findings = manifest.misplacedChannels ? [misplacedChannelsFinding()] : [];
      for (const finding of findings) problems.push(finding.words);
      let channels = {};
      if (files.includes(MARKETPLACE_CHANNELS_FILE)) {
        const channelsText = read(MARKETPLACE_CHANNELS_FILE, CHANNELS_FILE_BYTES);
        const parsed = channelsText == null ? { channels: {}, problems: [`${MARKETPLACE_CHANNELS_FILE} is larger than 64 KiB, so no channel is read.`] } : parseChannelsFile(channelsText);
        channels = parsed.channels;
        problems.push(...parsed.problems);
      }
      // Who the marketplace declares as code owners, from the first CODEOWNERS that exists [OMK:REQ-013].
      const ownersFile = CODEOWNERS_PATHS.find((file) => files.includes(file)) ?? null;
      let codeowners = null;
      if (ownersFile) {
        const ownersText = read(ownersFile, CODEOWNERS_LIMITS.bytes);
        codeowners = ownersText == null
          ? { path: ownersFile, rules: [], sections: [], problems: [`${ownersFile} is larger than 64 KiB, so it is not read: no path has code owners SFlow can see.`] }
          : parseCodeowners(ownersText, { path: ownersFile });
        problems.push(...codeowners.problems);
      }
      // The commit's own day, in its committer's time zone: no lifecycle entry is dated after it [OMK:REQ-003].
      const commitDate = /^\d{4}-\d{2}-\d{2}/u.exec(commitShape(root, commit)?.committedAt ?? '')?.[0] ?? null;
      const marketplaceOwner = { name: manifest.owner, email: manifest.ownerEmail };
      const packages = [];
      for (const listed of manifest.packages.filter((entry) => entry.source)) {
        const manifestPath = `${listed.source}/${MARKETPLACE_MANIFEST}`;
        const text = read(manifestPath, LIMITS.manifestBytes);
        if (text == null) { problems.push(`${listed.name}: ${manifestPath} is missing, so it is not read.`); continue; }
        let own;
        try { own = parsePackageManifest(text, { source: listed.source }); }
        catch (error) { problems.push(`${listed.name}: ${error.message}`); continue; }
        if (own.name && own.name !== listed.name) problems.push(`${listed.name}: its own ${manifestPath} calls it '${own.name}'; the marketplace's name is used.`);
        const document = documentOf(own.kind, listed.source, files);
        const lifecyclePath = `${listed.source}/${LIFECYCLE_RECORD_FILE}`;
        const lifecycleText = files.includes(lifecyclePath) ? read(lifecyclePath, LIFECYCLE_LIMITS.bytes) ?? '' : null;
        const metadata = packageMetadata({ name: listed.name, source: listed.source, own, lifecycleText, codeowners, marketplaceOwner, commitDate });
        packages.push({
          name: listed.name, kind: own.kind, type: own.type, version: own.version, description: own.description ?? listed.description,
          lifecycleState: own.lifecycleState, pdlcPhases: own.pdlcPhases, pdlcTasks: own.pdlcTasks, tags: own.tags, categories: own.categories,
          maintainer: own.maintainer, sourceRepository: own.sourceRepository,
          // What a workflow made from it records, so an update can tell its apm.yml changed (MCR §7).
          manifestSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
          source: listed.source, includePrerelease: listed.includePrerelease, dependencies: own.dependencies, document,
          owner: metadata.owner, lifecycleRecord: metadata.lifecycleRecord, findings: metadata.findings
        });
      }
      // Each local dependency named by the package it is; one the marketplace does not list stays a path.
      const bySource = new Map(packages.map((entry) => [entry.source, entry]));
      for (const entry of packages) {
        entry.dependencies = entry.dependencies.map((dependency) => ({ ...dependency, package: bySource.get(dependency.path)?.name ?? null }));
        entry.skills = entry.dependencies.map((dependency) => bySource.get(dependency.path)).filter((target) => target?.kind === 'skill').map((target) => target.name);
        for (const dependency of entry.dependencies.filter((item) => item.path && !item.package)) {
          problems.push(`${entry.name} depends on ${dependency.reference}, which the marketplace does not list.`);
        }
      }
      const wanted = new Set(typeof documents === 'function' ? documents(packages) : documents);
      for (const entry of packages) if (entry.document && wanted.has(entry.name)) entry.text = read(entry.document, LIMITS.documentBytes);
      return { commit, manifest, packages, problems, findings, channels, codeowners: ownersFile ? { path: ownersFile, rules: codeowners.rules.length } : null };
    });
  } catch (error) {
    if (error?.code === 'GIT_OBJECT_REPOSITORY_UNAVAILABLE') throw unreachable(`commit ${pinned.slice(0, 12)} could not be fetched.`, { stage: 'fetch' });
    if (error?.code === 'GIT_OBJECT_REPOSITORY_LIMIT') throw unreachable(`it is larger than ${LIMITS.repositoryBytes / 1024 / 1024} MiB.`, { stage: 'size' });
    if (error?.code === 'GIT_OBJECT_REPOSITORY_INVALID') {
      throw fail(`${label} holds a symbolic link, a submodule or another entry that is not a plain file at ${pinned.slice(0, 12)}, so SFlow does not read it. Ask its maintainers to remove it.`,
        'MARKETPLACE_REPOSITORY_INVALID', { repository: marketplace.repository, commit: pinned });
    }
    throw error;
  }
  return {
    schemaVersion: 1, resultType: MARKETPLACE_REPOSITORY_RESULT,
    repository: marketplace.repository, ref: marketplace.ref ?? null, commit: snapshot.commit,
    name: snapshot.manifest.name, description: snapshot.manifest.description, owner: snapshot.manifest.owner, ownerEmail: snapshot.manifest.ownerEmail ?? null,
    channels: snapshot.channels, channel: trustChannel(snapshot.channels, marketplace.ref ?? null), codeowners: snapshot.codeowners,
    packages: snapshot.packages, problems: snapshot.problems, findings: snapshot.findings
  };
}

/** What `marketplace browse` lists: the agents and skills, filtered by kind and by words in any field shown. */
export function marketplaceRepositoryView(catalog, { kind = null, search = null } = {}) {
  const query = String(search ?? '').trim().toLowerCase();
  return catalog.packages
    .filter((entry) => !kind || entry.kind === kind)
    .filter((entry) => !query || [entry.name, entry.description ?? '', entry.type ?? '', entry.lifecycleState ?? '', entry.owner?.name ?? '', entry.owner?.team ?? '',
      ...entry.tags, ...entry.pdlcPhases, ...entry.pdlcTasks, ...entry.skills].some((value) => String(value).toLowerCase().includes(query)))
    .map(({ text: _text, ...entry }) => entry);
}

/** The agent a `workflow from-agent` names, with its own text and every skill it depends on with theirs. */
export async function readMarketplaceAgent(marketplace, agentName) {
  const listing = await readMarketplaceRepository(marketplace, {
    documents: (packages) => { const own = packages.find((entry) => entry.name === agentName); return own ? [own.name, ...own.skills] : []; }
  });
  const agent = listing.packages.find((entry) => entry.name === agentName);
  const agents = listing.packages.filter((entry) => entry.kind === 'agent').map((entry) => entry.name);
  if (!agent) {
    throw fail(`Marketplace '${marketplace.id}' lists no package '${agentName}'.${agents.length ? ` Its agents: ${agents.join(', ')}.` : ' It lists no agents.'}`,
      'MARKETPLACE_AGENT_UNKNOWN', { marketplace: marketplace.id, agents });
  }
  if (agent.kind !== 'agent') {
    throw fail(`${agentName} in marketplace '${marketplace.id}' is a ${agent.type ?? 'package with no type'}, not an agent (type: agent).${agents.length ? ` Its agents: ${agents.join(', ')}.` : ''}`,
      'MARKETPLACE_AGENT_NOT_AGENT', { marketplace: marketplace.id, agents });
  }
  if (!agent.document || agent.text == null) {
    throw fail(`${agentName} has no readable agent.md in ${agent.source}, so there are no stages to turn into steps.`, 'MARKETPLACE_AGENT_NO_DOCUMENT');
  }
  const byName = new Map(listing.packages.map((entry) => [entry.name, entry]));
  return { listing, agent, skills: agent.skills.map((name) => byName.get(name)).filter(Boolean) };
}
