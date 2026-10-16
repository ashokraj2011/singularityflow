/**
 * The sections a phase's publication checks demand, and how a prepared artifact always gets them.
 *
 * A repository keeps its own copy of every artifact template (`<templatesRoot>/<ref>`). An install
 * does not replace it, Recreate & Sync does not, and an upgrade replaces it only while it is
 * byte-identical to a shipped revision. The checks, meanwhile, move with the engine and with
 * `workflow.yml`: a specification phase gained `scenarioCoverage: required` and a Scenario
 * coverage table on 2026-10-12, and a repository with an older or edited template prepared a
 * specification with no table to fill — its author had to invent the section, and sometimes did
 * not, so publication was refused.
 *
 * One rule closes that class: a freshly prepared artifact contains every section its phase will be
 * checked for. A missing section is copied from the packaged template that carries it (the
 * phase's own packaged template first, then any packaged template, in a fixed order), placed where
 * the packaged template places it; with no packaged source it is an empty heading with a TODO, so
 * the placeholder check still asks for content. An upgrade uses the same rule to add the missing
 * sections to an edited template without touching its wording.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeMarkdownHeading } from './markdown-structure.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { renderClauseNamespaces } from './traceability-ids.mjs';

/** Sections every enforced specification must have (specification-quality.mjs checks them). */
export const SPECIFICATION_REQUIRED_SECTIONS = Object.freeze(['Actors', 'User scenarios', 'Requirements']);

const PACKAGED_TEMPLATES = path.join(PACKAGE_ROOT, 'templates', 'artifacts');

/**
 * Every section heading `phase` (resolved, or as written in workflow.yml) is checked for:
 * the artifact's `validation.requiredHeadings`, an enforced or warned specification's required
 * sections, and Scenario coverage when the phase requires it.
 */
export function requiredArtifactSections(phase) {
  const sections = [];
  const add = (heading) => {
    const text = String(heading ?? '').replace(/^#+\s*/u, '').trim();
    if (text && !sections.some((existing) => normalizeMarkdownHeading(existing) === normalizeMarkdownHeading(text))) sections.push(text);
  };
  for (const heading of phase?.requiredArtifact?.validation?.requiredHeadings ?? phase?.artifact?.validation?.requiredHeadings ?? []) add(heading);
  const quality = phase?.specificationQuality;
  if (quality && (quality.mode ?? 'off') !== 'off') SPECIFICATION_REQUIRED_SECTIONS.forEach(add);
  if (quality?.scenarioCoverage === 'required') add('Scenario coverage');
  return sections;
}

/** Headings of a Markdown document, outside fenced code, with their level and line span. */
function headingsOf(lines) {
  const found = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(```+|~~~+)/u.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) found.push({ line: index, level: heading[1].length, normalized: normalizeMarkdownHeading(heading[2]) });
  });
  return found;
}

/** The line where the section starting at heading `at` ends (the next heading of the same or a higher level). */
function sectionEnd(lines, headings, at) {
  const next = headings.find((heading) => heading.line > headings[at].line && heading.level <= headings[at].level);
  return next ? next.line : lines.length;
}

const packagedTexts = new Map();
let packagedList = null;

function packagedTemplate(ref) {
  if (!packagedTexts.has(ref)) {
    let text = null;
    try { text = readFileSync(path.join(PACKAGED_TEMPLATES, ...String(ref).split('/')), 'utf8'); } catch {}
    packagedTexts.set(ref, text);
  }
  return packagedTexts.get(ref);
}

/** Every packaged artifact template, as `<dir>/<file>.md` refs in a fixed order. */
export function packagedTemplateRefs() {
  if (!packagedList) {
    const refs = [];
    const walk = (directory, prefix) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isDirectory()) walk(path.join(directory, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith('.md')) refs.push(`${prefix}${entry.name}`);
      }
    };
    try { walk(PACKAGED_TEMPLATES, ''); } catch {}
    packagedList = refs;
  }
  return packagedList;
}

/**
 * Where a section comes from: the phase's own packaged template, then any packaged template that
 * carries it. Returns `{ ref, lines, headings, index }` or null.
 */
export function packagedSectionSource(heading, ownRef = null) {
  const wanted = normalizeMarkdownHeading(heading);
  for (const ref of [ownRef, ...packagedTemplateRefs()].filter(Boolean)) {
    const text = packagedTemplate(ref);
    if (text == null) continue;
    const lines = text.split(/\r?\n/u);
    const headings = headingsOf(lines);
    const index = headings.findIndex((entry) => entry.normalized === wanted);
    if (index >= 0) return { ref, lines, headings, index };
  }
  return null;
}

/**
 * Add each of `sections` that `markdown` lacks, copying it from its packaged source and rendering
 * `tokens` (`{{work.id}}` and friends) into it. Returns `{ text, added: [{ heading, source }] }`.
 * Text that already has every section is returned unchanged, byte for byte.
 */
export function addMissingSections(markdown, sections, { ownRef = null, tokens = {} } = {}) {
  const source = String(markdown);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let lines = source.split(/\r?\n/u);
  const added = [];
  for (const heading of sections) {
    const headings = headingsOf(lines);
    const wanted = normalizeMarkdownHeading(heading);
    if (headings.some((entry) => entry.normalized === wanted)) continue;
    const donor = packagedSectionSource(heading, ownRef);
    let block;
    let at = -1;
    if (donor) {
      const end = sectionEnd(donor.lines, donor.headings, donor.index);
      block = donor.lines.slice(donor.headings[donor.index].line, end);
      while (block.length && block.at(-1).trim() === '') block.pop();
      block.push('');
      if (tokens['{{work.id}}'] !== undefined) block = block.map((line) => renderClauseNamespaces(line, '{{work.id}}', tokens['{{work.id}}']));
      for (const [token, value] of Object.entries(tokens)) block = block.map((line) => line.replaceAll(token, value ?? ''));
      // Place it after the nearest earlier packaged section the document has, else before the
      // nearest later one, so it lands where the packaged template puts it.
      const present = new Map(headings.map((entry, index) => [entry.normalized, index]));
      for (let index = donor.index - 1; index >= 0 && at < 0; index -= 1) {
        const match = present.get(donor.headings[index].normalized);
        if (match !== undefined) at = sectionEnd(lines, headings, match);
      }
      for (let index = donor.index + 1; index < donor.headings.length && at < 0; index += 1) {
        const match = present.get(donor.headings[index].normalized);
        if (match !== undefined) at = headings[match].line;
      }
    } else {
      block = [`## ${heading}`, '', 'TODO', ''];
    }
    if (at < 0) at = lines.length;
    if (at === lines.length && lines.length && lines.at(-1) !== '') block.unshift('');
    lines = [...lines.slice(0, at), ...block, ...lines.slice(at)];
    added.push({ heading, source: donor ? `templates/artifacts/${donor.ref}` : null });
  }
  return { text: added.length ? lines.join(newline) : source, added };
}

/** The template tokens a prepared artifact renders, for sections copied in after rendering. */
export function artifactTokens({ workItem = {}, phase = {} } = {}) {
  return {
    '{{work.id}}': workItem.id ?? '', '{{work.title}}': workItem.title ?? '', '{{work.type}}': workItem.workType ?? '',
    // {{inputs}} stays: the inputs step fills it after the sections are in place.
    '{{phase.id}}': phase.id ?? '', '{{phase.label}}': phase.label ?? ''
  };
}

/**
 * The repository templates that lack a section a phase using them is checked for, as
 * `[{ path, phases, missing }]`. Read-only: doctor reports these; Stories already scaffold them at
 * preparation, and an upgrade adds them to the template itself.
 */
export async function templateSectionGaps(root, definition) {
  const { lstat, readFile } = await import('node:fs/promises');
  const templatesRoot = String(definition?.templatesRoot ?? 'singularity/templates').replace(/\/+$/u, '');
  const byRef = new Map();
  const use = (ref, phaseId, phase) => {
    if (typeof ref !== 'string' || !ref || ref.includes(':') || ref.split('/').includes('..')) return;
    const entry = byRef.get(ref) ?? { phases: new Set(), sections: [] };
    entry.phases.add(phaseId);
    for (const heading of requiredArtifactSections(phase)) {
      if (!entry.sections.some((existing) => normalizeMarkdownHeading(existing) === normalizeMarkdownHeading(heading))) entry.sections.push(heading);
    }
    byRef.set(ref, entry);
  };
  for (const [id, phase] of Object.entries(definition?.phases ?? {})) use(phase?.defaultTemplate, id, phase);
  for (const workType of Object.values(definition?.workTypes ?? {})) {
    for (const [id, ref] of Object.entries(workType?.templateOverrides ?? {})) use(ref, id, definition?.phases?.[id]);
  }
  const gaps = [];
  for (const [ref, entry] of [...byRef].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!entry.sections.length) continue;
    const relative = `${templatesRoot}/${ref}`;
    const absolute = path.join(root, ...relative.split('/'));
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const present = new Set(headingsOf((await readFile(absolute, 'utf8')).split(/\r?\n/u)).map((heading) => heading.normalized));
    const missing = entry.sections.filter((heading) => !present.has(normalizeMarkdownHeading(heading)));
    if (missing.length) gaps.push({ path: relative, phases: [...entry.phases].sort(), missing });
  }
  return gaps;
}
