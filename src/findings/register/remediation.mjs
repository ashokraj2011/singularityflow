/**
 * Remediation Stories for the register [CQF:REQ-067, REQ-068].
 *
 * `findings plan` previews the groups: security findings per repository by due date, at most ten a
 * Story (decision 20, `stories.maximumFindings`); TLM items per component. `findings start` opens a
 * `findings-remediation` Story for one group, whose clauses are the group's items, and which runs
 * all existing tests (decision 22). A major upgrade is listed for a person and never made by itself
 * (decision 19); a patch or minor one is the code step's to make.
 *
 * When a Story that addresses items closes, the items move on (REQ-068). A TLM item closes when the
 * default branch's manifest, lockfile or runtime file shows at least its target version, and is fixed
 * awaiting proof until it does. A security finding is fixed awaiting rescan: only the security team's
 * next list, no longer calling it open, closes it (import does that).
 */
import { committedFileText, refCommit } from '../../git.mjs';
import { compareItems, setItemStates } from './model.mjs';
import { repositoryMatches } from './format.mjs';

const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'item';

/** `1.2.3`, `v22`, `4.17.21-beta` → numbers; non-numeric parts end it. */
export function versionParts(value) {
  const match = /(\d+(?:\.\d+)*)/u.exec(String(value ?? ''));
  return match ? match[1].split('.').map(Number) : null;
}

/** Whether `have` is at least `want`, comparing as many parts as `want` names (22 accepts 22.4.1). */
export function versionAtLeast(have, want) {
  const left = versionParts(have);
  const right = versionParts(want);
  if (!left || !right) return false;
  for (let index = 0; index < right.length; index += 1) {
    const a = left[index] ?? 0;
    if (a !== right[index]) return a > right[index];
  }
  return true;
}

/** patch, minor or major from one version to another; null when either is unknown. */
export function upgradeKind(from, to) {
  const left = versionParts(from);
  const right = versionParts(to);
  if (!left || !right) return null;
  if ((right[0] ?? 0) !== (left[0] ?? 0)) return 'major';
  if ((right[1] ?? 0) !== (left[1] ?? 0)) return 'minor';
  return 'patch';
}

/** A dependency or runtime item's upgrade kind, or null when it is not an upgrade. */
export function itemUpgrade(item) {
  if (item.feed === 'tlm') return upgradeKind(item.currentVersion, item.targetVersion);
  return item.package ? upgradeKind(item.installedVersion, item.fixedVersion) : null;
}

/**
 * The remediation groups for this repository's open items (every repository's with `allRepositories`).
 * `stories` is findings.yml's grouping: `{ security: { maximumFindings }, tlm: { maximumFindings } }`.
 */
export function planGroups(register, repository, { stories, allRepositories = false } = {}) {
  const open = (feed) => register[feed].items.filter((item) => item.state === 'open'
    && (allRepositories || repositoryMatches(item.repository, repository)));
  const groups = [];
  const describe = (item) => ({ id: item.id, severity: item.severity ?? null, dueAt: item.dueAt ?? null,
    label: item.feed === 'tlm' ? `${item.component} ${item.currentVersion ?? '?'} → ${item.targetVersion}` : item.title,
    upgrade: itemUpgrade(item) });
  const byRepository = new Map();
  for (const item of open('security')) {
    if (!byRepository.has(item.repository)) byRepository.set(item.repository, []);
    byRepository.get(item.repository).push(item);
  }
  const securityMaximum = stories?.security?.maximumFindings ?? 10;
  for (const [repositoryKey, items] of [...byRepository].sort(([left], [right]) => left.localeCompare(right))) {
    // By due date first (a finding with none goes last), then severity, so each Story meets its deadlines.
    const ordered = [...items].sort((left, right) => String(left.dueAt ?? '9999').localeCompare(String(right.dueAt ?? '9999')) || compareItems(left, right));
    for (let start = 0, number = 1; start < ordered.length; start += securityMaximum, number += 1) {
      const chunk = ordered.slice(start, start + securityMaximum);
      const dueAt = chunk.map((item) => item.dueAt).filter(Boolean).sort()[0] ?? null;
      const name = repositoryKey.split('/').at(-1);
      groups.push({ id: `security-${slug(name)}-${number}`, feed: 'security', repository: repositoryKey, dueAt,
        title: `Fix ${chunk.length} security finding${chunk.length === 1 ? '' : 's'} in ${name}${dueAt ? ` due by ${dueAt}` : ''}`,
        items: chunk.map(describe) });
    }
  }
  const byComponent = new Map();
  for (const item of open('tlm')) {
    const key = `${item.repository}\u0000${(item.ecosystem ?? '').toLowerCase()}\u0000${String(item.component).toLowerCase()}`;
    if (!byComponent.has(key)) byComponent.set(key, []);
    byComponent.get(key).push(item);
  }
  const tlmMaximum = stories?.tlm?.maximumFindings ?? 10;
  for (const [, items] of [...byComponent].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = [...items].sort(compareItems);
    const [first] = ordered;
    const target = ordered.map((item) => item.targetVersion).sort((left, right) => (versionAtLeast(left, right) ? -1 : 1))[0];
    for (let start = 0, number = 1; start < ordered.length; start += tlmMaximum, number += 1) {
      const chunk = ordered.slice(start, start + tlmMaximum);
      const suffix = allRepositories ? `-${slug(first.repository.split('/').at(-1))}` : '';
      groups.push({ id: `tlm-${slug(first.component)}${suffix}${number > 1 ? `-${number}` : ''}`, feed: 'tlm', repository: first.repository,
        dueAt: chunk.map((item) => item.dueAt).filter(Boolean).sort()[0] ?? null,
        title: `Upgrade ${first.component} to ${target} or later`, items: chunk.map(describe) });
    }
  }
  return groups.map((group) => ({
    ...group, count: group.items.length, workId: `FIX-${group.id.toUpperCase()}`.slice(0, 64),
    majorUpgrades: group.items.filter((item) => item.upgrade === 'major').map((item) => item.id)
  }));
}

/** A group's Story description: SFlow's words; the items themselves are the Story's clauses. */
export function groupDescription(group) {
  const majors = group.majorUpgrades.length
    ? ` A major upgrade (${group.majorUpgrades.join(', ')}) is listed in the remediation plan for a person to approve and is never made by itself.` : '';
  return `Remediate ${group.count} ${group.feed === 'tlm' ? 'TLM item' : 'security finding'}${group.count === 1 ? '' : 's'} from the findings register `
    + `(${group.items.map((item) => item.id).join(', ')}). Each is a clause of this Story with its proof; all existing tests run.${majors}`;
}

/** The files that can pin a component's version, read at `ref`; bounded, never executed. */
const PIN_FILES = Object.freeze(['package.json', '.nvmrc', '.node-version', 'Dockerfile', 'requirements.txt', 'pyproject.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'go.mod', '.python-version', '.java-version', '.tool-versions']);

/** Every version `component` is pinned at in the files at `ref`: `[{ file, version }]`. */
export function pinnedVersions(root, ref, component, { env = process.env } = {}) {
  const name = String(component ?? '').trim();
  const lower = name.toLowerCase();
  const found = [];
  const read = (file) => {
    const text = committedFileText(root, ref, file, { env });
    return text && text.length <= 1024 * 1024 ? text : null;
  };
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const runtimes = { node: ['.nvmrc', '.node-version'], nodejs: ['.nvmrc', '.node-version'], python: ['.python-version'], java: ['.java-version'] };
  for (const file of PIN_FILES) {
    const text = read(file);
    if (!text) continue;
    if (file === 'package.json') {
      try {
        const manifest = JSON.parse(text);
        for (const block of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          if (manifest[block]?.[name]) found.push({ file, version: String(manifest[block][name]) });
        }
        if (['node', 'nodejs'].includes(lower) && manifest.engines?.node) found.push({ file, version: String(manifest.engines.node) });
      } catch { /* not JSON: nothing pinned here */ }
    } else if (runtimes[lower]?.includes(file)) {
      const version = text.trim().split(/\s+/u)[0];
      if (version) found.push({ file, version });
    } else if (file === 'Dockerfile') {
      for (const match of text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+?):(\S+)/gimu)) {
        if (match[1].toLowerCase().split('/').at(-1) === lower) found.push({ file, version: match[2] });
      }
    } else if (file === '.tool-versions') {
      const match = new RegExp(`^${escaped}(?:js)?\\s+(\\S+)`, 'imu').exec(text);
      if (match) found.push({ file, version: match[1] });
    } else if (file === 'requirements.txt' || file === 'pyproject.toml') {
      const match = new RegExp(`["']?${escaped}\\s*(?:==|>=|~=)\\s*([0-9][^\\s"',;]*)`, 'imu').exec(text);
      if (match) found.push({ file, version: match[1] });
    } else if (file === 'pom.xml') {
      const match = new RegExp(`<artifactId>\\s*${escaped}[^<]*</artifactId>\\s*(?:<[^>]+>[^<]*</[^>]+>\\s*)*?<version>\\s*([^<\\s]+)\\s*</version>`, 'iu').exec(text);
      if (match) found.push({ file, version: match[1] });
    } else if (file.startsWith('build.gradle')) {
      const match = new RegExp(`["'][^"':]+:${escaped}:([^"']+)["']`, 'iu').exec(text);
      if (match) found.push({ file, version: match[1] });
    } else if (file === 'go.mod') {
      const match = new RegExp(`^\\s*(?:require\\s+)?\\S*${escaped}\\s+v?([0-9][^\\s]*)`, 'imu').exec(text);
      if (match) found.push({ file, version: match[1] });
    }
  }
  return found;
}

/** The TLM proof: the files pinning the component, and whether every one is at least the target. */
export function tlmProof(root, ref, item, { env = process.env } = {}) {
  const pins = pinnedVersions(root, ref, item.component, { env });
  const proven = pins.length > 0 && pins.every((pin) => versionAtLeast(pin.version.replace(/^[\^~>=v\s]+/u, ''), item.targetVersion));
  return { proven, pins: pins.slice(0, 10) };
}

/** A Story's status from its own branch, read locally: closed with a completion is a landed change. */
function storyClosed(root, story, workItemRoot, { env }) {
  for (const ref of [`refs/remotes/origin/${story.branch ?? story.workId}`, `refs/heads/${story.branch ?? story.workId}`]) {
    if (!refCommit(root, ref, { env })) continue;
    const text = committedFileText(root, ref, `${workItemRoot}/${story.workId}/workflow.json`, { env });
    if (!text) continue;
    try {
      const workflow = JSON.parse(text);
      return workflow.status === 'closed' && Boolean(workflow.completion) && workflow.cancellation == null;
    } catch { return false; }
  }
  return false;
}

/**
 * The register with each item whose Story has closed moved on: a TLM item to closed when the
 * default branch proves it, else fixed awaiting proof (checked again next time); a security finding
 * to fixed awaiting rescan. Returns the register and what moved.
 */
export function reconcileClosedStories(root, register, { defaultBranch = 'main', remote = 'origin', workItemRoot = 'singularity/work-items',
  at = new Date().toISOString(), env = process.env } = {}) {
  const proofRef = refCommit(root, `refs/remotes/${remote}/${defaultBranch}`, { env }) ? `refs/remotes/${remote}/${defaultBranch}` : `refs/heads/${defaultBranch}`;
  const moved = [];
  let next = register;
  const closed = new Map();
  for (const feed of ['security', 'tlm']) {
    for (const item of next[feed].items) {
      const waiting = item.state === 'in-story' || (feed === 'tlm' && item.state === 'fixed-awaiting-proof');
      if (!waiting || !item.story?.workId) continue;
      const key = item.story.workId;
      if (!closed.has(key)) closed.set(key, storyClosed(root, item.story, workItemRoot, { env }));
      if (!closed.get(key)) continue;
      if (feed === 'security') {
        next = setItemStates(next, feed, [item.id], 'fixed-awaiting-rescan', { at, reason: `Story ${key} closed; the security team's rescan closes it` }).register;
        moved.push({ id: item.id, to: 'fixed-awaiting-rescan', story: key });
        continue;
      }
      const proof = tlmProof(root, proofRef, item, { env });
      const state = proof.proven ? 'closed' : 'fixed-awaiting-proof';
      if (state === item.state) continue;
      next = setItemStates(next, feed, [item.id], state, {
        at, reason: proof.proven ? `${defaultBranch} pins ${item.component} at ${item.targetVersion} or later` : `Story ${key} closed; ${defaultBranch} does not show ${item.targetVersion} yet`,
        evidence: { at, story: key, kind: 'tlm-pin', ref: defaultBranch, pins: proof.pins, proven: proof.proven }
      }).register;
      moved.push({ id: item.id, to: state, story: key });
    }
  }
  return { register: next, moved };
}
