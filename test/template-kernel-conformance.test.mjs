import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { requiredArtifactSections } from '../src/artifact-required-sections.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { normalizeMarkdownHeading, parseMarkdownStructure } from '../src/markdown-structure.mjs';
import { inspectPlannedClaimMap, plannedClaimSource } from '../src/specifications.mjs';
import { renderClauseNamespaces } from '../src/traceability-ids.mjs';

/*
 * A packaged artifact skeleton is the first draft every author starts from, on any repository.
 * When its structure disagrees with the kernel that later validates it, every Story on that
 * workflow is refused at the same step until somebody rewrites the table by hand. These guards run
 * the kernel's own planned-claim parser and heading rules over the packaged skeletons, so a
 * skeleton can only ship in a shape the kernel accepts. Unfinished TODO cells (paths, tests) are
 * the author's work and are not judged here; the table's columns, divider, row widths, clause
 * cells, fulfillment values and step allocations are the template's.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'templates', 'artifacts');
const WORK_ID = 'DEMO-1';
// Diagnostic fields that the skeleton itself decides; path and test cells stay TODO for the author.
const TEMPLATE_OWNED_FIELDS = new Set(['header', 'divider', 'row', 'clause', 'fulfillment', 'steps', 'observableResult']);
const PLANNED_HEADER = /^\|\s*clause\s*\|\s*expected paths\s*\|\s*planned tests\s*\|/imu;

async function markdownFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(target);
  }
  return found.sort();
}

function rendered(text) {
  return renderClauseNamespaces(text, '{{work.id}}', WORK_ID)
    .replaceAll('{{work.id}}', WORK_ID).replaceAll('{{inputs}}', '');
}

function clauseIdsIn(text) {
  // Every qualified clause the skeleton itself names; a fixed namespace such as POC counts too.
  return [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9_-]*:(?:REQ|BEH|IFC|AC|CON)-\d{3}\b/gu)].map((match) => match[0]))];
}

async function packagedWorkTypes() {
  const definition = validateDefinition(YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8')));
  return Object.keys(definition.workTypes).map((id) => resolveWorkType(definition, id));
}

const skeleton = (ref) => readFile(path.join(ARTIFACTS, ...String(ref).split('/')), 'utf8');

test('every planned-evidence table in a packaged skeleton has the columns and values the kernel accepts', async () => {
  let tables = 0;
  const problems = [];
  for (const file of await markdownFiles(ARTIFACTS)) {
    const text = rendered(await readFile(file, 'utf8'));
    if (!PLANNED_HEADER.test(plannedClaimSource(text))) continue;
    tables += 1;
    const inspected = inspectPlannedClaimMap(text, { clauseIds: clauseIdsIn(text) });
    for (const finding of inspected.diagnostics.filter((entry) => TEMPLATE_OWNED_FIELDS.has(entry.field))) {
      problems.push(`${path.relative(ARTIFACTS, file)}:${finding.line ?? '?'} ${finding.field}: ${finding.message}`);
    }
  }
  assert.ok(tables >= 10, `expected the packaged planning skeletons to carry planned-evidence tables, found ${tables}`);
  assert.deepEqual(problems, [], 'a packaged skeleton must not ship a planned-evidence table the kernel refuses');
});

test('every workflow step skeleton carries each section its publication checks for, with visible guidance', async () => {
  const problems = [];
  let checked = 0;
  for (const workType of await packagedWorkTypes()) {
    for (const phase of workType.phases) {
      if (!phase.template) continue;
      const structure = parseMarkdownStructure(await skeleton(phase.template));
      for (const section of requiredArtifactSections(phase)) {
        checked += 1;
        const heading = structure.headings.find((entry) => entry.normalized === normalizeMarkdownHeading(section));
        if (!heading) { problems.push(`${workType.id}/${phase.id} (${phase.template}): missing "${section}"`); continue; }
        // HTML comments are not read as guidance, so a section holding only a comment leaves the author nothing to fill.
        if (!structure.visibleText.slice(heading.contentStart, heading.end).trim()) {
          problems.push(`${workType.id}/${phase.id} (${phase.template}): "${section}" has no visible text outside comments`);
        }
      }
    }
  }
  assert.ok(checked > 100, `expected the packaged steps to declare required sections, found ${checked}`);
  assert.deepEqual(problems, []);
});

test('every Agent brief in a packaged skeleton asks for visible text, not only a template comment', async () => {
  // The Agent brief projection reads visible text only; a brief left as the shipped comment is
  // refused when a later step consumes it, so the skeleton must show the author what to write.
  const problems = [];
  let briefs = 0;
  for (const file of await markdownFiles(ARTIFACTS)) {
    const structure = parseMarkdownStructure(await readFile(file, 'utf8'));
    for (const heading of structure.headings.filter((entry) => entry.normalized === 'agent brief')) {
      briefs += 1;
      if (!structure.visibleText.slice(heading.contentStart, heading.end).trim()) problems.push(path.relative(ARTIFACTS, file));
    }
  }
  assert.ok(briefs >= 5, `expected packaged skeletons with an Agent brief, found ${briefs}`);
  assert.deepEqual(problems, []);
});

test('every step that owns planned claims starts from a skeleton with a planned-evidence table', async () => {
  const problems = [];
  for (const workType of await packagedWorkTypes()) {
    if (workType.plannedClaims?.mode !== 'required') continue;
    for (const owner of new Set(Object.values(workType.plannedClaims.owners ?? {}))) {
      const phase = workType.phases.find((entry) => entry.id === owner);
      assert.ok(phase, `${workType.id}: planned-claim owner ${owner} is one of its steps`);
      if (!PLANNED_HEADER.test(plannedClaimSource(rendered(await skeleton(phase.template))))) {
        problems.push(`${workType.id}/${owner} (${phase.template})`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
