import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileAtRef, refHead } from './git.mjs';
import { SingularityFlowError, exists, readJson, run } from './util.mjs';

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function storyEntry(state, location) {
  const id = String(state?.workItem?.id ?? '').trim();
  if (!id || !state?.phases || !Array.isArray(state?.phaseOrder)) return null;
  const canonicalBranch = String(state.lineage?.canonicalBranch ?? state.workItem?.branch ?? id).trim();
  const branches = unique([
    state.workItem?.branch,
    canonicalBranch,
    ...(state.lineage?.childBranches ?? []).map((entry) => entry?.name)
  ]);
  const aliases = unique([
    id,
    state.lineage?.planId,
    state.lineage?.jiraIssueId,
    state.lineage?.initialJiraKey,
    state.lineage?.currentJiraKey,
    ...(state.lineage?.aliases ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.value ?? entry?.key)
  ]);
  return { kind: 'story', id, canonicalBranch, branches, aliases, state, location };
}

function initiativeEntry(state, location) {
  const id = String(state?.initiative?.id ?? '').trim();
  if (!id || !state?.phases || !Array.isArray(state?.phaseOrder)) return null;
  const canonicalBranch = String(state.initiative?.branch ?? id).trim();
  const branches = unique([canonicalBranch, ...(state.lineage?.branches ?? [])]);
  const aliases = unique([
    id,
    state.initiative?.jiraIssueId,
    state.initiative?.initialJiraKey,
    state.initiative?.currentJiraKey,
    ...(state.lineage?.aliases ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.value ?? entry?.key)
  ]);
  return { kind: 'initiative', id, canonicalBranch, branches, aliases, state, location };
}

function parseEntry(relative, content, location) {
  let state;
  try { state = typeof content === 'string' ? JSON.parse(content) : content; } catch { return null; }
  if (relative.endsWith('/workflow.json')) return storyEntry(state, { ...location, path: relative });
  if (relative.endsWith('/state.json')) return initiativeEntry(state, { ...location, path: relative });
  return null;
}

function preferredLocation(entry, location) {
  if (!entry.location) return location;
  if (location.branch === entry.canonicalBranch && entry.location.branch !== entry.canonicalBranch) return location;
  if (location.source === 'working-tree' && entry.location.source !== 'working-tree') return location;
  return entry.location;
}

export class RepositorySubjectIndex {
  constructor() {
    this.subjects = [];
  }

  add(candidate) {
    if (!candidate) return;
    const candidateLocation = { ...candidate.location, state: candidate.state };
    const existing = this.subjects.find((entry) => entry.kind === candidate.kind && entry.id === candidate.id);
    if (!existing) {
      this.subjects.push({ ...candidate, location: candidateLocation, locations: [candidateLocation] });
      return;
    }
    existing.branches = unique([...existing.branches, ...candidate.branches]);
    existing.aliases = unique([...existing.aliases, ...candidate.aliases]);
    existing.locations.push(candidateLocation);
    const selected = preferredLocation(existing, candidateLocation);
    if (selected === candidateLocation) {
      existing.location = candidateLocation;
      existing.state = candidate.state;
      existing.canonicalBranch = candidate.canonicalBranch;
    }
  }

  list(kind = null) {
    return this.subjects.filter((entry) => !kind || entry.kind === kind)
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  }

  matches(reference, { kind = null } = {}) {
    const requested = String(reference ?? '').trim();
    if (!requested) return [];
    return this.list(kind).filter((entry) => [entry.id, ...entry.aliases, ...entry.branches].includes(requested));
  }
}

async function scanDirectory(index, root, base, suffix, parser) {
  if (!(await exists(base))) return;
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(base, entry.name, suffix);
    if (!(await exists(absolute))) continue;
    try {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      index.add(parser(await readJson(absolute), { source: 'working-tree', path: relative, branch: null, ref: null, commit: null }));
    } catch { /* Invalid state is reported by governance; it cannot become a selectable subject. */ }
  }
}

export async function buildRepositorySubjectIndex(root, { definition = {}, portfolio = null } = {}) {
  const index = new RepositorySubjectIndex();
  await scanDirectory(index, root, path.join(root, definition.workItemRoot ?? 'singularity/work-items'), 'workflow.json', storyEntry);
  await scanDirectory(index, root, path.join(root, portfolio?.initiativeRoot ?? 'singularity/initiatives'), 'state.json', initiativeEntry);
  return index;
}

function refFiles(root, ref, roots) {
  const result = run('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', ...roots], { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter((file) => file.endsWith('/workflow.json') || file.endsWith('/state.json'));
}

export async function buildRepositorySubjectIndexFromRefs(root, {
  definition = {},
  portfolio = null,
  refs = []
} = {}) {
  const index = new RepositorySubjectIndex();
  const workRoot = String(definition.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '');
  const initiativeRoot = String(portfolio?.initiativeRoot ?? 'singularity/initiatives').replace(/\/$/, '');
  for (const item of refs) {
    const ref = typeof item === 'string' ? item : item.ref;
    const branch = typeof item === 'string' ? item.split('/').slice(1).join('/') : item.branch;
    for (const relative of refFiles(root, ref, [workRoot, initiativeRoot])) {
      const content = fileAtRef(root, ref, relative);
      const candidate = content && parseEntry(relative, content, {
        source: 'ref', ref, branch, commit: refHead(root, ref)
      });
      index.add(candidate);
    }
  }
  return index;
}

function candidateText(candidates) {
  return candidates.map((entry) => `${entry.kind}:${entry.id} (${entry.canonicalBranch})`).join(', ');
}

export function resolveContext(index, {
  reference,
  kind = null,
  required = true,
  mutation = false,
  creation = false
} = {}) {
  const requested = String(reference ?? '').trim();
  if (!requested) {
    if (!required) return null;
    throw new SingularityFlowError('Enter a Story, Initiative, canonical branch, or registered child branch reference.');
  }
  const candidates = index.matches(requested, { kind });
  if (candidates.length > 1) {
    throw new SingularityFlowError(`Subject reference '${requested}' is ambiguous. Choose one of: ${candidateText(candidates)}.`);
  }
  if (!candidates.length) {
    if (creation) return { kind, id: requested, canonicalBranch: requested, selectedBranch: requested, source: 'creation-fallback', state: null };
    if (!required) return null;
    throw new SingularityFlowError(`No governed ${kind ?? 'subject'} matches '${requested}'.`);
  }
  const resolved = candidates[0];
  if (mutation && resolved.readOnly) {
    throw new SingularityFlowError(`${resolved.kind} '${resolved.id}' was resolved from evidence only and cannot be mutated until its lifecycle branch is available.`);
  }
  const selectedBranch = resolved.branches.includes(requested) ? requested : resolved.canonicalBranch;
  const selectedLocation = resolved.locations.find((location) => location.branch === selectedBranch)
    ?? resolved.locations.find((location) => location.branch === resolved.canonicalBranch)
    ?? resolved.location;
  return {
    ...resolved,
    location: selectedLocation,
    state: selectedLocation?.state ?? resolved.state,
    selectedBranch,
    source: selectedLocation?.source ?? 'working-tree'
  };
}
