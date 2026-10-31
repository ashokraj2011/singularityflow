/**
 * The repository's APM packages as the panel reads them: `singularity-flow apm status --json`
 * (sflow-apm-status), checked before it is shown. No process or repository operation lives here.
 */
export interface ApmPrimitive { kind: string; name: string; target: string }
export interface ApmPackage {
  label: string; version: string | null; commit: string | null; depth: number;
  files: { total: number; ok: number; missing: number; modified: number };
  primitives: ApmPrimitive[];
}
export interface ApmBinding { agent: string; steps: string[]; defaultFor: string[]; active: boolean; waiting: string | null }
export interface ApmUnusable { name: string; path: string; package: string; reason: string }
export interface ApmFinding { code: string; message: string; owner: string | null }
export interface ApmAction { command: string; why: string }
export interface ApmView {
  state: string; project: string | null; lockedBy: string | null; packages: ApmPackage[];
  /** The agents packages deployed to .github/agents that SFlow can use: what Attach offers. */
  apmAgents: string[];
  /** This repository's own agents (IDs), not from APM: what Share offers. */
  ownAgents: string[];
  bindings: ApmBinding[]; unusable: ApmUnusable[]; findings: ApmFinding[]; cli: string | null; nextActions: ApmAction[];
}

export const APM_STATE_WORDS: Record<string, string> = {
  absent: 'This repository has no APM project yet (no apm.yml or apm.lock.yaml).',
  unreadable: 'The APM files cannot be read.',
  drifted: 'Some deployed files are no longer the ones apm install wrote.',
  unlocked: 'Some declared packages are not locked yet.',
  uncommitted: 'The APM files are intact but not all committed.',
  intact: 'Every deployed file matches apm.lock.yaml and is committed.'
};

const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown): string | null => (text(value) ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter(text) : []);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** An agent, step or APM package name: lower-case kebab-case, at most 64 characters, as the CLI checks it. */
const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export function kebabName(value: string): string | null {
  const name = value.trim();
  return name.length <= 64 && AGENT_ID.test(name) ? name : null;
}

/** The view, or null when the result is not an apm status this panel reads. */
export function apmView(raw: unknown): ApmView | null {
  const outer = record(raw);
  const status = outer?.resultType === 'sflow-apm-status' ? outer : record(record(outer?.data)?.status ?? outer?.data);
  if (!status || status.resultType !== 'sflow-apm-status' || !text(status.state) || !Array.isArray(status.packages)) return null;
  const manifest = record(status.manifest);
  const lock = record(status.lock);
  const packages = status.packages.map(record).filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.label))).map((entry) => {
    const files = record(entry.files) ?? {};
    return {
      label: entry.label as string, version: optionalText(entry.version), commit: optionalText(entry.commit), depth: count(entry.depth) || 1,
      files: { total: count(files.total), ok: count(files.ok), missing: count(files.missing), modified: count(files.modified) },
      primitives: (Array.isArray(entry.primitives) ? entry.primitives : []).map(record)
        .filter((item): item is Record<string, unknown> => Boolean(item && text(item.kind) && text(item.name)))
        .map((item) => ({ kind: item.kind as string, name: item.name as string, target: optionalText(item.target) ?? '' }))
    };
  });
  const agents = record(status.agents) ?? {};
  const bindings = Object.entries(record(agents.bindings) ?? {}).map(([agent, value]) => {
    const binding = record(value) ?? {};
    return { agent, steps: texts(binding.steps), defaultFor: texts(binding.defaultFor), active: binding.active !== false, waiting: optionalText(binding.waiting) };
  });
  const unusable = (Array.isArray(agents.unusable) ? agents.unusable : []).map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.name) && text(entry.reason)))
    .map((entry) => ({ name: entry.name as string, path: optionalText(entry.path) ?? '', package: optionalText(entry.package) ?? '', reason: entry.reason as string }));
  const findings = (Array.isArray(status.findings) ? status.findings : []).map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.message)))
    .map((entry) => ({ code: optionalText(entry.code) ?? '', message: entry.message as string, owner: optionalText(entry.owner) }));
  const nextActions = (Array.isArray(status.nextActions) ? status.nextActions : []).map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.command)))
    .map((entry) => ({ command: entry.command as string, why: optionalText(entry.why) ?? '' }));
  const project = manifest ? [optionalText(manifest.name), optionalText(manifest.version)].filter(Boolean).join(' ') || '(no name)' : null;
  const unreadable = new Set(unusable.map((entry) => entry.name));
  const apmAgents = [...new Set(packages.flatMap((entry) => entry.primitives.filter((item) => item.kind === 'agent' && item.target === '.github')
    .map((item) => item.name)))].filter((name) => AGENT_ID.test(name) && !unreadable.has(name)).sort();
  return {
    state: status.state, project, lockedBy: lock ? optionalText(lock.apmVersion) : null, packages, apmAgents,
    ownAgents: texts(status.unmanagedAgents).map((file) => file.replace(/^\.github\/agents\//u, '').replace(/(?:\.agent)?\.md$/u, ''))
      .filter((id) => AGENT_ID.test(id)),
    bindings, unusable, findings, cli: optionalText(record(status.cli)?.found), nextActions
  };
}

/** What `apm attach --dry-run --json` (a Studio plan) or `apm attach --json` (a command result) says. */
export interface ApmAttachResult { valid: boolean; summary: string[]; problems: string[]; branch: string | null }
export function apmAttachResult(raw: unknown): ApmAttachResult {
  const outer = record(raw);
  const plan = outer?.resultType === 'command-result' ? record(outer.data) ?? {} : outer ?? {};
  return {
    valid: plan.valid !== false,
    summary: texts(plan.summary),
    problems: (Array.isArray(plan.problems) ? plan.problems : []).map(record).map((entry) => optionalText(entry?.message)).filter(text),
    branch: optionalText(plan.branch)
  };
}

/** What `apm publish --json` says (sflow-apm-publish), as the confirmation and the result read it. */
export interface ApmPublishResult {
  package: string; version: string; previousVersion: string | null; marketplace: string; branch: string | null;
  unchanged: boolean; files: Array<{ path: string; bytes: number }>; stepsKeptHere: Array<{ agent: string; steps: string[] }>;
}
export function apmPublishResult(raw: unknown): ApmPublishResult | null {
  const result = record(raw);
  if (!result || !text(result.package) || !text(result.version) || !text(result.marketplace)) return null;
  return {
    package: result.package, version: result.version, previousVersion: optionalText(result.previousVersion),
    marketplace: result.marketplace, branch: optionalText(result.branch), unchanged: result.unchanged === true,
    files: (Array.isArray(result.files) ? result.files : []).map(record)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.path)))
      .map((entry) => ({ path: entry.path as string, bytes: count(entry.bytes) })),
    stepsKeptHere: (Array.isArray(result.stepsKeptHere) ? result.stepsKeptHere : []).map(record)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.agent)))
      .map((entry) => ({ agent: entry.agent as string, steps: texts(entry.steps) }))
  };
}

/** The confirmation's detail: the files the package holds, and what stays in this repository. */
export function apmPublishDetail(preview: ApmPublishResult): string {
  return [
    `${preview.package} ${preview.version}${preview.previousVersion ? ` (was ${preview.previousVersion})` : ' (new)'}, on ${preview.branch ?? 'a new branch'} in the marketplace's checkout:`,
    ...preview.files.map((file) => `  ${file.path} (${file.bytes} bytes)`),
    ...preview.stepsKeptHere.map((entry) => `${entry.agent}'s steps here (${entry.steps.join(', ')}) stay in this repository; a repository that installs the package chooses them with Attach.`),
    'It is committed for a pull request there. Nothing is pushed.'
  ].join('\n');
}

/** A package as the CLI accepts it: a marketplace name, a repository reference or a local path; never options. */
export function packageSpec(value: string): string | null {
  const spec = value.trim();
  return spec && !spec.startsWith('-') && !/\s/u.test(spec) && spec.length <= 512 ? spec : null;
}

/** One argument for the person's shell: kept as it is when plain, single-quoted otherwise. */
export function shellArgument(value: string): string {
  return /^[\w./@:#~+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
