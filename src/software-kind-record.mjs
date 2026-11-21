/**
 * The kind of software each app or service is, recorded once and confirmed by a person (step intents spec §12.1).
 *
 * software-kinds.mjs reads each project's kind from its committed files. This module keeps the person's word on it:
 * the first time, SFlow shows what it sees in one line ("SFlow sees orders-service as a backend (spring-boot-starter-web
 * in pom.xml). Right?") and the person confirms it with the short code that line carries, or names another kind. After
 * that the recorded kind is used and nothing asks again; a project the record does not name yet is shown as detected.
 *
 * The record is per capability, kept with this clone's private SFlow files (under the Git common directory), so every
 * Story worktree of the clone reads the same one. It records nothing about a Story and is never committed.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { SOFTWARE_KINDS } from './software-kinds.mjs';
import { SingularityFlowError } from './util.mjs';

export const SOFTWARE_KIND_RECORD_FORMAT = 'sflow-software-kinds/v1';
const MAXIMUM_RECORD_BYTES = 64 * 1024;

/** What a kind is called in a sentence: "a web app", "a backend (API or service)". */
export const KIND_WORDS = Object.freeze({
  web: 'a web app', backend: 'a backend (API or service)', job: 'a batch job or worker', cli: 'a command-line tool',
  library: 'a library', mobile: 'a mobile app', artifact: 'infrastructure or other files that are validated, not run'
});

const digestOf = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const projectName = (project) => project.name ?? (project.root || null) ?? project.id;

export async function softwareKindRecordPath(root, capabilityId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(capabilityId ?? '')) || capabilityId === '..') {
    throw new SingularityFlowError(`'${capabilityId}' is not a capability ID; the kind of software is recorded per capability.`, { code: 'SOFTWARE_KIND_CAPABILITY_INVALID',
      details: { nextAction: { command: 'singularity-flow capability kind --json', label: 'Show the kinds of this checkout\'s capability.' } } });
  }
  const { gitCommonDir } = await import('./git.mjs');
  return path.join(gitCommonDir(root), 'singularity-flow', 'software-kinds', `${capabilityId}.json`);
}

/** The recorded kinds of `capabilityId` on this clone, or null when none is recorded (or the record is unreadable). */
export async function readSoftwareKindRecord(root, capabilityId) {
  const { readPrivateSidecar } = await import('./private-sidecar.mjs');
  let bytes;
  try { bytes = await readPrivateSidecar(root, await softwareKindRecordPath(root, capabilityId), { optional: true, maximumBytes: MAXIMUM_RECORD_BYTES }); }
  catch { return null; }
  if (!bytes) return null;
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    if (record?.format !== SOFTWARE_KIND_RECORD_FORMAT || record.capability !== capabilityId || !Array.isArray(record.projects)
        || record.projects.some((entry) => typeof entry?.id !== 'string' || !SOFTWARE_KINDS.includes(entry.kind))) return null;
    return record;
  } catch { return null; }
}

/**
 * Every kind recorded on this clone, whatever the capability (`{ projects }`, each with its folder and kind): a cheap read
 * for the review's checklist, which never detects anything itself. Empty when nothing is recorded yet.
 */
export async function recordedSoftwareKinds(root) {
  const { readdir } = await import('node:fs/promises');
  const directory = path.dirname(await softwareKindRecordPath(root, 'probe'));
  let names = [];
  try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).slice(0, 20); } catch { return { projects: [] }; }
  const records = await Promise.all(names.map((name) => readSoftwareKindRecord(root, name.slice(0, -5))));
  return { projects: records.filter(Boolean).flatMap((record) => record.projects.map((project) => ({ ...project, confirmed: true }))) };
}

/** `--kind PROJECT=KIND` values as a map, refused when a kind or project is not one SFlow knows. */
export function parseKindOverrides(values, projects) {
  const overrides = new Map();
  for (const value of values ?? []) {
    const match = /^([^=\s]+)=([a-z]+)$/u.exec(String(value));
    const id = match?.[1] === 'this' && projects.length === 1 ? projects[0].id : match?.[1];
    if (!match || !SOFTWARE_KINDS.includes(match[2])) {
      throw new SingularityFlowError(`--kind takes PROJECT=KIND, with KIND one of ${SOFTWARE_KINDS.join(', ')}; '${value}' is not that.`,
        { code: 'SOFTWARE_KIND_USAGE', details: { nextAction: 'singularity-flow capability kind --json' } });
    }
    if (!projects.some((project) => project.id === id)) {
      throw new SingularityFlowError(`There is no project '${match[1]}' here; the projects are ${projects.map((project) => project.id).join(', ')}.`,
        { code: 'SOFTWARE_KIND_PROJECT_UNKNOWN', details: { nextAction: 'singularity-flow capability kind --json', projects: projects.map((project) => project.id) } });
    }
    overrides.set(id, match[2]);
  }
  return overrides;
}

/**
 * The kinds of `capabilityId`'s projects as SFlow uses them: each project's recorded kind once a person confirmed it,
 * else its detected one, marked unconfirmed. `detected` is detectSoftwareKinds's result for the checkout, `record` its
 * recorded kinds (or null) and `overrides` a person's corrections not confirmed yet. Pure.
 */
export function effectiveSoftwareKinds(capabilityId, detected, record = null, overrides = new Map()) {
  const recorded = new Map((record?.projects ?? []).map((entry) => [entry.id, entry]));
  const projects = (detected?.projects ?? []).map((project) => {
    const kept = recorded.get(project.id);
    const kind = overrides.get(project.id) ?? kept?.kind ?? project.kind ?? null;
    return { id: project.id, name: project.name ?? null, root: project.root ?? '', kind, detected: project.kind ?? null,
      confidence: project.confidence, signals: [...(project.signals ?? [])], also: [...(project.also ?? [])],
      confirmed: Boolean(kept) && !overrides.has(project.id),
      ...(kept && project.kind && kept.kind !== project.kind ? { detectedNow: project.kind } : {}) };
  });
  // What a person confirms: each project's ID, folder and kind, exactly as shown.
  const proposal = { capability: capabilityId, projects: projects.map(({ id, root, kind }) => ({ id, root, kind })) };
  return { capability: capabilityId, projects, confirmed: projects.length > 0 && projects.every((project) => project.confirmed && project.kind),
    digest: digestOf(proposal) };
}

/** The one line a person reads the first time, naming what SFlow sees for each unconfirmed project. */
export function kindQuestion(kinds) {
  const open = kinds.projects.filter((project) => !project.confirmed);
  if (!open.length) return null;
  const said = open.map((project) => {
    const name = projectName(project) === 'repository-root' ? 'this repository' : projectName(project);
    if (!project.kind) return `SFlow cannot tell what kind of software ${name} is`;
    const why = project.signals.length ? ` (${project.signals.slice(0, 2).join('; ')})` : '';
    return `SFlow sees ${name} as ${KIND_WORDS[project.kind]}${why}`;
  });
  return `${said.join('. ')}. Right?`;
}

/** A ready `capability kind` command naming each kind `project` is not shown as now. */
function kindChoices(project, own, sets) {
  return SOFTWARE_KINDS.filter((kind) => kind !== project.kind).map((kind) => ({ kind,
    command: ['singularity-flow capability kind', ...own, ...sets, `--kind ${project.id}=${kind}`, '--json'].join(' ') }));
}

/** The read `capability kind` shows: the kinds, the question while one is unconfirmed, and its confirm and correct routes. */
export async function softwareKindsView(root, { capabilityId = null, overrides: requested = [] } = {}) {
  const [{ checkoutFilesWithText }, { detectSoftwareKinds, softwareKindTextFiles }] = await Promise.all([
    import('./repository-projects-source.mjs'), import('./software-kinds.mjs')]);
  const capability = capabilityId ?? await currentCapabilityId(root);
  const read = checkoutFilesWithText(root, (files) => softwareKindTextFiles(files));
  const detected = detectSoftwareKinds(read);
  const record = await readSoftwareKindRecord(root, capability);
  const overrides = parseKindOverrides(requested, detected.projects);
  const kinds = effectiveSoftwareKinds(capability, detected, record, overrides);
  const question = kindQuestion(kinds);
  const sets = [...overrides].map(([id, kind]) => `--kind ${id}=${kind}`);
  const own = capabilityId ? ['--capability', capabilityId] : [];
  const confirm = question || overrides.size ? { command: ['singularity-flow capability kind', ...own, ...sets, '--confirm', kinds.digest].join(' '),
    words: overrides.size ? 'Record the kinds as corrected.' : 'Yes: record these kinds.' } : null;
  const unknown = kinds.projects.find((project) => !project.kind) ?? kinds.projects.find((project) => !project.confirmed) ?? kinds.projects[0];
  // No: one ready command per other kind, nothing to fill in; each shows the corrected line to confirm.
  const correct = unknown ? { project: unknown.id, words: 'No: run the one for its kind; SFlow shows the corrected line to confirm.',
    choices: kindChoices(unknown, own, sets.filter((entry) => !entry.startsWith(`--kind ${unknown.id}=`))) } : null;
  return { schemaVersion: 1, resultType: 'sflow-software-kinds', capability, projects: kinds.projects, confirmed: kinds.confirmed, digest: kinds.digest,
    ...(record ? { recordedAt: record.confirmedAt ?? null } : {}), question, ...(confirm ? { confirm } : {}), ...(question ? { correct } : {}),
    notes: [...detected.notes] };
}

/**
 * Record the kinds a person confirmed: exactly the ones `digest` names, from what this checkout shows now. A digest that
 * no longer matches (the files or an earlier record changed since the line was shown) is refused with the fresh read.
 */
export async function confirmSoftwareKinds(root, { capabilityId = null, digest, overrides: requested = [] } = {}) {
  const view = await softwareKindsView(root, { capabilityId, overrides: requested });
  if (digest !== view.digest) {
    throw new SingularityFlowError('What SFlow sees changed since that line was shown, so nothing was recorded. Read it again and confirm the new line.',
      { code: 'SOFTWARE_KIND_CHANGED', details: { nextAction: { command: `singularity-flow capability kind${capabilityId ? ` --capability ${capabilityId}` : ''} --json`,
        label: 'Show the current kinds and their line to confirm.' } } });
  }
  if (view.projects.some((project) => !project.kind)) {
    const unknown = view.projects.find((project) => !project.kind);
    const choices = kindChoices(unknown, capabilityId ? ['--capability', capabilityId] : [], []);
    throw new SingularityFlowError(`SFlow cannot tell what kind of software ${projectName(unknown)} is, so there is nothing to confirm for it yet. Name its kind with one of the commands given; each shows the line to confirm.`,
      { code: 'SOFTWARE_KIND_UNKNOWN', details: { nextAction: { command: choices[0].command, label: `If ${projectName(unknown)} is ${KIND_WORDS[choices[0].kind]}.` },
        recoveryCommands: choices.slice(1).map((choice) => ({ command: choice.command, label: `If it is ${KIND_WORDS[choice.kind]}.` })) } });
  }
  const { identity } = await import('./git.mjs');
  const actor = identity(root, { offline: true });
  const record = { format: SOFTWARE_KIND_RECORD_FORMAT, capability: view.capability, digest: view.digest, confirmedAt: new Date().toISOString(),
    confirmedBy: actor?.name ?? actor?.login ?? null,
    projects: view.projects.map(({ id, root: folder, kind, detected }) => ({ id, root: folder, kind, detected })) };
  const file = await softwareKindRecordPath(root, view.capability);
  const { safePrivateSidecarDirectory, writeMutablePrivateSidecar } = await import('./private-sidecar.mjs');
  await safePrivateSidecarDirectory(root, path.dirname(file), { create: true });
  await writeMutablePrivateSidecar(root, file, `${JSON.stringify(record, null, 2)}\n`, { maximumBytes: MAXIMUM_RECORD_BYTES });
  return { ...view, projects: view.projects.map((project) => ({ ...project, confirmed: true })), confirmed: true, question: null, confirm: undefined, correct: undefined,
    recorded: true, recordedAt: record.confirmedAt };
}

/** The capability this checkout's application belongs to, as Run & Test selects it; the repository's own otherwise. */
export async function currentCapabilityId(root) {
  try {
    const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
    return (await resolveCapabilityApplication(root, { readApplication: false })).capabilityId;
  } catch {
    const { IMPLICIT_CAPABILITY_ID } = await import('./capabilities.mjs');
    return IMPLICIT_CAPABILITY_ID;
  }
}

/**
 * The kinds of the projects `paths` touch (a project owns the paths under its folder; the innermost one wins), from a
 * softwareKindsView-shaped `kinds`. A path under no project belongs to the repository's own project when there is one.
 */
export function kindsTouched(kinds, paths) {
  const projects = [...(kinds?.projects ?? [])].sort((left, right) => (right.root ?? '').length - (left.root ?? '').length);
  const touched = new Map();
  for (const file of paths ?? []) {
    const owner = projects.find((project) => !project.root || file === project.root || file.startsWith(`${project.root}/`));
    if (owner) touched.set(owner.id, owner);
  }
  return [...touched.values()];
}
