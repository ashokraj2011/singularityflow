/**
 * Does each step's template give its author what the engine will later demand of the document?
 *
 * A team's own template used to be judged only when a Story reached its step: a requirements
 * template without clause anchors, or a plan template whose table the kernel does not read, passed
 * `workflow check` and `workflow validate` and then stopped every Story at the same step. Here each
 * template is read once, rendered the way step entry renders it (the same token admission and clause
 * namespaces, with a sample Work ID), and run through the kernel's own readers:
 *
 * - a step that defines the requirement clauses (plannedClaims.clausePhases) must define at least
 *   one clause anchor the specification index reads (`[<WORK>:REQ-001]`, `[<WORK>:AC-001]`);
 * - a step that plans a code step's claims (plannedClaims.owners) must hold a planned-claims table
 *   the planned-claim parser accepts as a table (header, columns, divider, row widths, clause and
 *   fulfillment cells); TODO paths and tests are the author's to fill and are not judged;
 * - every section the step's publication checks for should be in the template (preparation copies a
 *   missing one in, so this is a warning);
 * - the template must exist, be a plain file, and use only tokens step entry renders.
 *
 * Deterministic and read-only: no model, no Git, nothing written. Templates an agent supplies
 * (`agent:<id>/<template>`) and skill steps have no file here and are not judged.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isAgentTemplateReference } from './agent-document-parser.mjs';
import { requiredArtifactSections } from './artifact-required-sections.mjs';
import { renderArtifactTemplateText } from './config.mjs';
import { normalizeMarkdownHeading, parseMarkdownStructure } from './kernel/artifact-content.mjs';
import { scaffoldPlanningRows } from './phase-authoring-contract.mjs';
import { extractClauses, inspectPlannedClaimMap, plannedClaimSource } from './specifications.mjs';
import { normalizeSpecPolicy } from "./kernel/configuration-policy.mjs";

/** The Work ID templates are rendered with; any Story's ID renders the same structure. */
export const SAMPLE_WORK_ID = 'CHECK-1';
/** The planned-claims table header the kernel reads, with its optional columns. */
export const PLANNED_TABLE_HEADER = '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |';
const PLANNED_TABLE_DIVIDER = '|---|---|---|---|---|';
const PLANNED_HEADER = /^\|\s*clause\s*\|\s*expected paths\s*\|\s*planned tests\s*\|/imu;
// What the template itself decides about the table; path and test cells stay TODO for the author.
const TEMPLATE_OWNED_FIELDS = new Set(['header', 'divider', 'row', 'clause', 'fulfillment', 'steps', 'observableResult']);
const CLAUSE_ID = /\b[A-Z][A-Z0-9_-]*:(?:REQ|BEH|IFC|AC|CON)-\d{3}\b/gu;
const MAX_TABLE_FINDINGS = 3;
// Each Story's author fills a Verification intent table's methods; its TODO cells are not the template's.
const VERIFICATION_INTENT_HEADING = /^(#{1,6}[ \t]+)verification intent([ \t]*#*[ \t]*)$/gimu;

const lineOf = (text, index) => String(text).slice(0, index).split('\n').length;
const lineIn = (message) => Number(/\bline (\d+)\b/u.exec(String(message ?? ''))?.[1]) || null;

/**
 * Reads each template once for every workflow checked. A path outside the templates root, a
 * symbolic link or anything but a file is reported as the engine would refuse it, never followed.
 */
export function templateReader(configRoot, templatesRoot) {
  const cache = new Map();
  return (template) => {
    const file = path.posix.join(templatesRoot, template);
    if (!cache.has(file)) {
      cache.set(file, (async () => {
        const normalized = path.posix.normalize(file);
        if (path.posix.isAbsolute(template) || normalized.startsWith('../') || !normalized.startsWith(`${path.posix.normalize(templatesRoot)}/`)) {
          return { file, text: null, reason: 'outside' };
        }
        const absolute = path.join(configRoot, ...normalized.split('/'));
        const info = await lstat(absolute).catch(() => null);
        if (!info) return { file, text: null, reason: 'missing' };
        if (info.isSymbolicLink()) return { file, text: null, reason: 'link' };
        if (!info.isFile()) return { file, text: null, reason: 'not-file' };
        return readFile(absolute, 'utf8').then((text) => ({ file, text }), () => ({ file, text: null, reason: 'unreadable' }));
      })());
    }
    return cache.get(file);
  };
}

const UNREADABLE = Object.freeze({
  missing: 'does not exist',
  link: 'is a symbolic link, which step entry refuses',
  'not-file': 'is not a file',
  outside: 'is outside the templates folder',
  unreadable: 'cannot be read'
});

const ANCHOR_FIX = (file) => `Write each requirement and acceptance criterion in ${file} with its anchor, for example "- The export includes every row. [{{work.id}}:REQ-001]" and "- A CSV with 3 rows downloads. [{{work.id}}:AC-001]". `
  + 'The anchor gives the clause its ID; code later carries @clause:<WORK>:REQ-001 and tests @ac:<WORK>:AC-001.';
const TABLE_FIX = (file, codeLabel) => `Give ${file} the planned-claims table the kernel reads, one row per clause the code step ${codeLabel} must meet:\n`
  + `${PLANNED_TABLE_HEADER}\n${PLANNED_TABLE_DIVIDER}\n| \`{{work.id}}:REQ-001\` | TODO: replace with exact backticked repository-relative source paths | TODO: replace with exact backticked repository-relative test paths | new | TODO: what a person can observe when it works |`;

/**
 * Findings about the templates of one resolved workflow. Each is `{ code, severity, title, detail,
 * step, template, location, fix, stopsAt }`: `template` is the path inside the templates folder a
 * Workflow Studio `template.update` names, and `stopsAt` says where a Story would stop. `read` comes from
 * templateReader, shared by every workflow so each template is read once.
 */
export async function templateConformanceFindings(resolved, { read, label = (id) => id } = {}) {
  const findings = [];
  const claims = resolved.plannedClaims ?? {};
  const required = claims.mode === 'required';
  const clausePhases = new Set(required ? claims.clausePhases ?? [] : []);
  const ownerOf = new Map();
  for (const [codeId, ownerId] of Object.entries(required ? claims.owners ?? {} : {})) ownerOf.set(ownerId, [...(ownerOf.get(ownerId) ?? []), codeId]);
  const spec = (() => { try { return normalizeSpecPolicy(resolved.spec ?? {}); } catch { return normalizeSpecPolicy({}); } })();
  const workId = spec.namespace ?? SAMPLE_WORK_ID;
  // The clauses earlier clause steps' templates define: what a later step may cite or depend on.
  const defined = [];
  let clauseStepBefore = false;
  for (const phase of resolved.phases ?? []) {
    const after = clauseStepBefore;
    if (clausePhases.has(phase.id)) clauseStepBefore = true;
    if (phase.kind === 'skill' || !phase.template || isAgentTemplateReference(phase.template)) continue;
    const add = (entry) => findings.push({ step: phase.id, template: phase.template, ...entry });
    const prior = defined.map((clause) => clause.id);
    const source = await read(phase.template);
    if (source.text == null) {
      add({ code: 'CHECK_TEMPLATE_MISSING', severity: 'problem', title: `The template of ${label(phase.id)} ${UNREADABLE[source.reason] ?? 'cannot be read'}`,
        detail: `${source.file} ${UNREADABLE[source.reason] ?? 'cannot be read'}, so a Story cannot prepare ${label(phase.id)}.`,
        location: { file: source.file, line: null }, fix: `Create ${source.file}, or point the step at a template that exists.`,
        stopsAt: { step: phase.id, when: 'entry' } });
      continue;
    }
    let rendered;
    try {
      rendered = renderArtifactTemplateText(source.text, phase, { id: workId, title: 'Sample Story', workType: resolved.id, inputs: '' });
    } catch (error) {
      const token = /\{\{[^{}\r\n]+\}\}/u.exec(String(source.text).replace(/\{\{(?:work\.(?:id|title|type)|phase\.(?:id|label)|inputs|WORK_ID)\}\}/gu, (match) => ' '.repeat(match.length)));
      add({ code: 'CHECK_TEMPLATE_TOKEN_UNSUPPORTED', severity: 'problem', title: `The template of ${label(phase.id)} uses a token step entry cannot fill`,
        detail: error.message, location: { file: source.file, line: token ? lineOf(source.text, token.index) : null },
        fix: 'Use only {{work.id}}, {{work.title}}, {{work.type}}, {{phase.id}}, {{phase.label}} and {{inputs}}, or write the text out.',
        stopsAt: { step: phase.id, when: 'entry' } });
      continue;
    }
    const structure = parseMarkdownStructure(rendered);
    const headings = new Set(structure.headings.map((heading) => heading.normalized));
    const missing = requiredArtifactSections(phase).filter((section) => !headings.has(normalizeMarkdownHeading(section)));
    if (missing.length) {
      add({ code: 'CHECK_TEMPLATE_HEADING_MISSING', severity: 'warning',
        title: `The template of ${label(phase.id)} lacks ${missing.length === 1 ? `the section "${missing[0]}"` : `${missing.length} sections its publication checks for`}`,
        detail: `Publication of ${label(phase.id)} checks for ${missing.map((section) => `"${section}"`).join(', ')}. Each Story's draft gets ${missing.length === 1 ? 'it' : 'them'} copied in from the packaged template, without your template's guidance.`,
        location: { file: source.file, line: 1 }, fix: `Add ${missing.map((section) => `"## ${section}"`).join(', ')} to ${source.file}, with a line saying what to write there.` });
    }

    if (clausePhases.has(phase.id)) {
      let clauses = null;
      try {
        clauses = extractClauses(rendered.replace(VERIFICATION_INTENT_HEADING, '$1Verification intent, filled per Story$2'), { sourcePath: source.file, namespace: spec.namespace, limits: spec.limits, externalClauses: defined });
      } catch (error) {
        add({ code: 'CHECK_TEMPLATE_CLAUSE_ANCHORS', severity: 'problem', title: `The clause anchors in the template of ${label(phase.id)} are refused`,
          detail: `${error.message} Publishing ${label(phase.id)} refuses the same document.`,
          location: { file: source.file, line: error.details?.line ?? lineIn(error.message) }, fix: ANCHOR_FIX(source.file),
          stopsAt: { step: phase.id, when: 'publication' } });
      }
      if (clauses && !clauses.length) {
        add({ code: 'CHECK_TEMPLATE_CLAUSE_ANCHORS', severity: 'problem', title: `The template of ${label(phase.id)} defines no requirement clauses`,
          detail: `${label(phase.id)} defines this workflow's requirement clauses, and its publication requires stable clause anchors such as [${workId}:REQ-001]. `
            + `${source.file} has none outside comments and code, so every Story stops when ${label(phase.id)} is published, and the code step has nothing to trace to.`,
          location: { file: source.file, line: structure.headings.find((heading) => /requirement|acceptance|criteria/u.test(heading.normalized))?.line ?? 1 },
          fix: ANCHOR_FIX(source.file), stopsAt: { step: phase.id, when: 'publication' } });
      }
      if (clauses?.length) defined.push(...clauses);
    }

    if (ownerOf.has(phase.id)) {
      const codeSteps = ownerOf.get(phase.id);
      const codeLabel = codeSteps.map(label).join(' and ');
      // Step entry fills a placeholder table with the clauses earlier steps defined; judge that draft
      // (with a sample clause when an earlier clause template is itself refused).
      const scaffold = prior.length ? prior : after ? [`${workId}:REQ-001`] : [];
      const draft = scaffold.length ? scaffoldPlanningRows(rendered, scaffold) : rendered;
      const visible = plannedClaimSource(draft);
      // Publishing the plan refuses a clause it does not plan; the code step refuses to start without the plan.
      const stopsAt = { step: phase.id, when: 'publication' };
      if (!PLANNED_HEADER.test(visible)) {
        const lines = visible.split(/\r?\n/u);
        const near = lines.findIndex((line) => /^\s*\|\s*`?\s*clause(?:\s+id)?\s*`?\s*\|/iu.test(line) && /path|test/iu.test(line));
        add({ code: 'CHECK_TEMPLATE_PLANNED_TABLE', severity: 'problem', title: `The template of ${label(phase.id)} has no planned-claims table the kernel reads`,
          detail: `${label(phase.id)} plans what ${codeLabel} must deliver: publishing it requires a planned-claims row for every clause, and ${codeLabel} refuses to start without that plan. `
            + (near >= 0 ? `The table at line ${near + 1} starts "${lines[near].trim()}", and the kernel reads a planned-claims table only when its header starts | Clause | Expected paths | Planned tests |.`
              : `${source.file} has no table whose header starts | Clause | Expected paths | Planned tests |, so every author has to invent it.`),
          location: { file: source.file, line: near >= 0 ? near + 1 : 1 }, fix: TABLE_FIX(source.file, codeLabel), stopsAt });
      } else {
        const known = [...new Set([...scaffold, ...(visible.match(CLAUSE_ID) ?? [])])];
        const inspected = inspectPlannedClaimMap(draft, { clauseIds: known, policy: spec });
        const owned = inspected.diagnostics.filter((entry) => TEMPLATE_OWNED_FIELDS.has(entry.field));
        for (const entry of owned.slice(0, MAX_TABLE_FINDINGS)) {
          add({ code: 'CHECK_TEMPLATE_PLANNED_TABLE', severity: 'problem', title: `The planned-claims table in the template of ${label(phase.id)} is refused`,
            detail: `${entry.message}${owned.length > MAX_TABLE_FINDINGS && entry === owned[MAX_TABLE_FINDINGS - 1] ? ` (and ${owned.length - MAX_TABLE_FINDINGS} more)` : ''} Publishing ${label(phase.id)} refuses the same table, and ${codeLabel} cannot start until it is published.`,
            location: { file: source.file, line: entry.line ?? null }, fix: TABLE_FIX(source.file, codeLabel), stopsAt, kernelCode: entry.code });
        }
      }
    }
  }
  return findings;
}

/** The planned-claims header row and divider the kernel reads, for fix texts and skills. */
export function plannedTableExample() {
  return `${PLANNED_TABLE_HEADER}\n${PLANNED_TABLE_DIVIDER}`;
}
