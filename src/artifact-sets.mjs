/**
 * Typed artifact sets. `[SPK:REQ-110]` `[SPK:REQ-111]` `[SPK:CON-045]`
 *
 * A phase has always had one *required artifact* and an open-ended list of registered files. That is
 * enough to answer "did they write the thing?" and not enough to answer "is this bundle complete?"
 * — a specification whose quality checklist is missing looks exactly like one that never had a
 * checklist, and a reviewer approving `spec.md` has no idea whether they are approving one document
 * or four.
 *
 * An artifact set names the members, gives each a role, and says which are required. Each member is
 * hashed individually `[SPK:REQ-110]`, and the set as a whole gets one content-addressed
 * `bundleSha256`. That single value is what `[SPK:CON-045]` means by "the exact complete phase
 * bundle": a reviewer may talk about one member, but the approval binds all of them, so fixing a
 * member after approval cannot leave the approval standing.
 *
 * Member paths are relative to the directory holding the primary — the same directory the phase's
 * `artifact-only` write scope already permits — so a set cannot quietly widen what a generation may
 * write.
 */
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { recordSha256 } from './records.mjs';
import { exists, posix, SingularityFlowError } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

/** How much a member's absence or change is allowed to mean. */
export const MEMBER_AUTHORITIES = Object.freeze(['governed', 'advisory']);

/** The catalogue shape `catalogArtifactSet` writes and `artifactSetDiff` reads. `[SPK:REQ-124]` */
export const ARTIFACT_SET_SCHEMA_VERSION = currentSchemaVersion('artifact-set');

/**
 * Normalize one declared set.
 *
 * Validated at configuration load rather than at first use. The set shipped in `workflow.yml` had no
 * reader at all until this module existed; a declaration nothing validates and nothing consumes is
 * indistinguishable from one that works.
 */
export function normalizeArtifactSet(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Artifact set '${id}' must be an object.`);
  }
  const primary = String(value.primary ?? '').trim();
  if (!primary) throw new SingularityFlowError(`Artifact set '${id}' must name its primary member.`);
  const members = value.members ?? [];
  if (!Array.isArray(members) || !members.length) {
    throw new SingularityFlowError(`Artifact set '${id}' must list at least one member.`);
  }
  const seen = new Set();
  const normalized = members.map((member, index) => {
    if (!member || typeof member !== 'object') throw new SingularityFlowError(`Artifact set '${id}' member ${index + 1} must be an object.`);
    const memberPath = posix(String(member.path ?? '').trim());
    if (!memberPath) throw new SingularityFlowError(`Artifact set '${id}' member ${index + 1} needs a path.`);
    if (memberPath.startsWith('/') || memberPath.split('/').includes('..')) {
      throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' must stay inside the phase artifact directory.`);
    }
    if (seen.has(memberPath)) throw new SingularityFlowError(`Artifact set '${id}' lists '${memberPath}' twice.`);
    seen.add(memberPath);
    const role = String(member.role ?? '').trim();
    if (!role) throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' needs a role.`);
    const authority = member.authority ?? 'governed';
    if (!MEMBER_AUTHORITIES.includes(authority)) {
      throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' authority must be one of ${MEMBER_AUTHORITIES.join(', ')}.`);
    }
    // An advisory member is a planning aid, never evidence `[SPK:CON-046]`. Requiring one would make
    // it evidence by the back door, so the two cannot be combined.
    if (authority === 'advisory' && member.required === true) {
      throw new SingularityFlowError(`Artifact set '${id}' member '${memberPath}' is advisory, so it cannot be required.`);
    }
    return { path: memberPath, role, required: member.required === true, authority };
  });
  if (!normalized.some((member) => member.path === posix(primary))) {
    throw new SingularityFlowError(`Artifact set '${id}' primary '${primary}' is not among its members.`);
  }
  return Object.freeze({ id, primary: posix(primary), members: Object.freeze(normalized) });
}

export function normalizeArtifactSets(value = {}) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('artifactSets must be an object.');
  return Object.fromEntries(Object.entries(value).map(([id, set]) => [id, normalizeArtifactSet(set, id)]));
}

/** The directory members are named relative to: the one holding the phase's required artifact. */
export function memberRoot(phase) {
  const artifact = phase?.requiredArtifact?.path ?? phase?.artifact?.path ?? '';
  const directory = path.posix.dirname(posix(String(artifact)));
  return directory === '.' ? '' : directory;
}

/** The set a phase declares, resolved through the Story's pinned resolution first. */
export function resolvedArtifactSet(definition, workflow, phase) {
  const resolved = workflow?.resolution?.phases?.find((entry) => entry.id === phase.id);
  const id = resolved?.artifactSet ?? phase?.artifactSet ?? definition?.phases?.[phase.id]?.artifactSet ?? null;
  if (!id) return null;
  const sets = workflow?.resolution?.artifactSets ?? definition?.artifactSets ?? {};
  const set = sets[id];
  if (!set) throw new SingularityFlowError(`Phase '${phase.id}' declares unknown artifact set '${id}'.`);
  /**
   * Always normalized, never "normalized if it looks normalized".
   *
   * This read `set.members ? set : normalizeArtifactSet(set, id)`, on the theory that a set with
   * members had already been through the normalizer. Raw YAML has members too — so a Story whose
   * resolution predates artifact sets fell back to the definition and got the raw object, which
   * carries no `id` and no defaulted `authority`. The catalogue then recorded `setId: undefined`
   * and lost the governed/advisory distinction, silently. Normalizing twice costs nothing.
   */
  return normalizeArtifactSet(set, id);
}

async function hashFile(absolute) {
  return createHash('sha256').update(await readFile(absolute)).digest('hex');
}

/**
 * A directory member's hash: every file beneath it, by relative path and content.
 *
 * `verification/` is a member in the shipped verification set, and a collection of evidence is only
 * the same collection if the same files are in it. Hashing the concatenation of sorted
 * `path\0hash` pairs makes adding, removing or editing any file change the member.
 */
async function hashDirectory(absolute, relative = '', entries = []) {
  for (const entry of (await readdir(path.join(absolute, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) await hashDirectory(absolute, child, entries);
    else if (entry.isFile()) entries.push([child, await hashFile(path.join(absolute, child))]);
  }
  if (relative) return entries;
  const digest = createHash('sha256');
  for (const [child, hash] of entries.sort((left, right) => left[0].localeCompare(right[0]))) digest.update(`${child}\0${hash}\n`);
  return { sha256: digest.digest('hex'), files: entries.length };
}

/**
 * Hash and catalogue every member of a phase's set. `[SPK:REQ-110]`
 *
 * Reads from disk rather than from `phase.artifacts`, because the registered-artifact list is a
 * record of what someone chose to register and the set is a statement of what the phase owes.
 */
export async function catalogArtifactSet(root, workDirRelativePath, phase, set) {
  if (!set) return null;
  const rootRelative = posix(path.posix.join(workDirRelativePath, memberRoot(phase)));
  const members = [];
  for (const member of set.members) {
    const relative = posix(path.posix.join(rootRelative, member.path));
    const absolute = path.join(root, relative);
    const directory = member.path.endsWith('/');
    const present = await exists(absolute);
    let sha256 = null;
    let bytes = null;
    let files = null;
    if (present) {
      const info = await stat(absolute);
      if (info.isDirectory()) ({ sha256, files } = await hashDirectory(absolute));
      else { sha256 = await hashFile(absolute); bytes = info.size; }
    }
    members.push({
      path: relative, member: member.path, role: member.role, required: member.required,
      authority: member.authority, directory, exists: present, sha256, bytes, files
    });
  }
  const ordered = [...members].sort((left, right) => left.path.localeCompare(right.path));
  return {
    // `[SPK:REQ-124]`. The catalogue outlives the build that wrote it: it is persisted on the phase
    // and read back a generation later by `artifactSetDiff`. Every sibling record in this pack
    // carries a version and this one did not, so a future change to the member shape would have
    // been compared against the old shape in silence. Safe to add: `bundleSha256` below hashes an
    // explicit subset, so the approval identity of existing bundles is unchanged.
    schemaVersion: ARTIFACT_SET_SCHEMA_VERSION,
    resultType: 'artifact-set-catalog',
    setId: set.id,
    primary: posix(path.posix.join(rootRelative, set.primary)),
    members: ordered,
    // The one value `[SPK:CON-045]` calls the exact complete bundle. Order-independent by
    // construction, so how the members were listed cannot change a Story's approval identity.
    bundleSha256: recordSha256({
      setId: set.id,
      members: ordered.map(({ path: memberPath, role, sha256 }) => ({ path: memberPath, role, sha256 }))
    }),
    missingRequired: ordered.filter((member) => member.required && !member.exists).map((member) => member.path)
  };
}

/**
 * What changed between two catalogues of the same set. `[SPK:REQ-111]`
 *
 * `declared` names the members a surgical reopen said it would regenerate. Everything else that
 * moved is *incidental*, and the clause asks that it be disclosed rather than refused — a
 * regeneration that reflowed a neighbouring paragraph is usually harmless and always worth knowing
 * about, and refusing it outright would push people into rewriting the whole bundle instead.
 */
export function artifactSetDiff(previous, current, { declared = [] } = {}) {
  if (!previous || !current) return { changed: [], preserved: [], incidental: [], declared: [...declared] };
  /**
   * A catalogue written before the version stamp is version 1 — that is the shape that shipped, and
   * `[SPK:CON-053]` says an existing Story keeps working. A version *ahead* of this build is the
   * case worth refusing: the members would be compared field by field against a shape this code
   * does not know, and the answer would be a confident wrong diff rather than an error.
  */
  const stored = { schemaVersion: 1, ...previous };
  let readablePrevious;
  try { readablePrevious = readRecord('artifact-set', stored).record; }
  catch (error) {
    if (error?.code === 'SCHEMA_VERSION_FUTURE') {
      throw new SingularityFlowError(
        `Artifact set was catalogued by a newer release. ${error.message}`,
        { code: error.code, details: error.details, cause: error }
      );
    }
    throw error;
  }
  const before = new Map(readablePrevious.members.map((member) => [member.path, member]));
  const intended = new Set(declared.map((entry) => posix(entry)));
  const changed = [];
  const preserved = [];
  for (const member of current.members) {
    const earlier = before.get(member.path);
    if (!earlier) { changed.push({ ...member, reason: 'the member is new' }); continue; }
    if (earlier.sha256 === member.sha256) preserved.push(member);
    else changed.push({ ...member, reason: earlier.exists ? 'the member bytes changed' : 'the member was added' });
  }
  for (const [memberPath, earlier] of before) {
    if (earlier.exists && !current.members.some((member) => member.path === memberPath && member.exists)) {
      changed.push({ ...earlier, sha256: null, exists: false, reason: 'the member was removed' });
    }
  }
  return {
    changed,
    preserved,
    declared: [...intended],
    incidental: intended.size ? changed.filter((member) => !intended.has(member.path) && !intended.has(member.member)) : []
  };
}

/** The prose a surgical reopen owes its reader. `[SPK:REQ-111]` */
export function disclosureLines(diff) {
  return [
    ...diff.incidental.map((member) => `${member.path} changed although the reopen did not ask for it: ${member.reason}`),
    ...(diff.declared.length && !diff.changed.length ? ['the reopen declared members to regenerate and none of them changed'] : [])
  ];
}
