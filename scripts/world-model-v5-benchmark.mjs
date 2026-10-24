#!/usr/bin/env node
/**
 * Measure the Repository brief against the World Model v5 quality bar (docs/KNOWLEDGE-MODEL.md,
 * "Measuring it").
 *
 *   node scripts/world-model-v5-benchmark.mjs --repository PATH --spec FILE [--json]
 *
 * A spec (see test/fixtures/knowledge/briefs/*.json) names a Story, the phases to brief, and labels
 * a person wrote for the repository: the docs-to-code links that are right, the docs statements that
 * are rules, the callers and tests a change must reach, the words that make a line relevant to the
 * Story, and optionally a recorded model answer for the polish checks. Briefs are read from the
 * repository as it is (a Story's change is whatever the working tree changes against HEAD), with no
 * model; the recorded answer stands in for one. Nothing is written but the machine-local caches.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readDocumentation } from '../src/knowledge/brief.mjs';
import { repositoryBriefPrompt } from '../src/knowledge/prompt.mjs';
import { buildImpactRecords, knowledgePaths, readChange } from '../src/knowledge/records/impact.mjs';
import { buildRuleRecords } from '../src/knowledge/records/rules.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

export const QUALITY_BAR = Object.freeze({
  maximumBytes: 4096, cited: 1, notKnownLines: 1, linkPrecision: 0.9, statementPrecision: 0.85,
  impactRecall: 0.9, relevantFirst: 1, polishViolations: 0
});

const has = (text, needle) => String(text).toLowerCase().includes(String(needle).toLowerCase());

/**
 * A brief's statements (its bullets, without the "more" pointer) and how many cite a source: a
 * closing "(file:line)", "(file › heading)" or "(commit …)", or a leading file path.
 */
export function briefQuality(text) {
  const lines = String(text).split('\n');
  const statements = lines.filter((line) => line.startsWith('- ') && !line.startsWith('- … '));
  const cited = (line) => /\((?:[^()]*\.[\w]+(?::\d+)?|[^()]*›[^()]*|commit [0-9a-f]{7,})\)$/u.test(line)
    || /^- (?:\(changed by this Story\) )?[\w.-]+\/[\w./-]+/u.test(line);
  return {
    bytes: Buffer.byteLength(text),
    statements: statements.length,
    cited: statements.filter(cited).length,
    uncited: statements.filter((line) => !cited(line)),
    notKnownLines: lines.filter((line) => line.startsWith('Not known:')).length
  };
}

/** Within each section, whether the lines about the Story come first (up to five of them). */
export function relevantFirst(text, relevant) {
  const sections = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('## ')) sections.push({ title: line.slice(3), lines: [] });
    else if (line.startsWith('- ') && !line.startsWith('- … ') && sections.length) sections.at(-1).lines.push(line);
  }
  const scored = sections.filter((section) => section.title !== 'What exists').map((section) => {
    const flags = section.lines.map((line) => relevant.some((word) => has(line, word)));
    const k = Math.min(5, flags.filter(Boolean).length);
    return { title: section.title, k, first: flags.slice(0, k).filter(Boolean).length };
  }).filter((section) => section.k > 0);
  const k = scored.reduce((sum, section) => sum + section.k, 0);
  return { sections: scored, score: k ? scored.reduce((sum, section) => sum + section.first, 0) / k : null };
}

/** Docs-to-code links: each rule record that cites both, and whether a labelled pair describes it. */
export function linkPrecision(records, expected = []) {
  const links = records.filter((record) => record.sources.code.length && record.sources.docs.length);
  const said = (record) => [record.origin === 'docs' ? record.text : '', ...(record.quotes ?? [])].join('\n');
  const code = (record) => [record.text, JSON.stringify(record.parts ?? {}), ...record.sources.code.map((source) => `${source.path}:${source.line} ${source.symbol ?? ''}`)].join('\n');
  const correct = links.filter((record) => expected.some((pair) => has(said(record), pair.docs) && has(code(record), pair.code)));
  const found = expected.filter((pair) => links.some((record) => has(said(record), pair.docs) && has(code(record), pair.code)));
  return {
    links: links.length, correct: correct.length, precision: links.length ? correct.length / links.length : null,
    expected: expected.length, found: found.length, recall: expected.length ? found.length / expected.length : null,
    wrong: links.filter((record) => !correct.includes(record)).map((record) => record.text)
  };
}

/** Docs statements read as rules, and how many of them a person labelled a rule. */
export function statementPrecision(statements, genuine = []) {
  const kept = statements.filter((statement) => genuine.some((needle) => has(statement.text, needle)));
  return {
    extracted: statements.length, genuine: kept.length, precision: statements.length ? kept.length / statements.length : null,
    other: statements.filter((statement) => !kept.includes(statement)).map((statement) => statement.text)
  };
}

/** Of the callers, endpoints and tests a change must reach, how many the impact records name. */
export function impactRecall(records, expected = []) {
  const text = records.map((record) => `${record.text} ${JSON.stringify(record.parts ?? {})}`).join('\n');
  const found = expected.filter((needle) => has(text, needle));
  return { expected: expected.length, found: found.length, recall: expected.length ? found.length / expected.length : null, missed: expected.filter((needle) => !found.includes(needle)) };
}

/** Measure one repository against one spec. */
export async function measureRepository(root, spec, { polishAnswer = null } = {}) {
  const story = { title: spec.story.title, description: spec.story.description ?? null, acceptanceCriteria: spec.story.acceptanceCriteria ?? [], baseCommit: 'HEAD' };
  const changedPaths = spec.change?.paths ?? [];
  const briefs = {};
  for (const phase of spec.phases) {
    const brief = await repositoryBriefPrompt(root, { definition: null, phase, workflow: { workItem: story }, changedPaths, polish: 'off' });
    briefs[phase] = { profile: brief.profile, budget: brief.budget, ...briefQuality(brief.text), relevance: relevantFirst(brief.text, spec.labels?.relevant ?? []), text: brief.text };
  }
  const built = await buildKnowledge(root, {});
  const knowledge = built.knowledge;
  const focus = [story.title, story.description, ...story.acceptanceCriteria].filter(Boolean).join(' ');
  const documentation = readDocumentation(root, { focus });
  const records = buildRuleRecords(knowledge, documentation, { focus });
  const known = knowledgePaths(knowledge);
  const change = changedPaths.length ? await readChange(root, 'HEAD', { paths: changedPaths, keep: (file) => known.has(file) }) : null;
  const impact = change ? buildImpactRecords(knowledge, { changedPaths, changedRanges: change.changedRanges, focus }) : [];
  let polish = null;
  if (polishAnswer) {
    const recorded = { model: 'recorded', output: JSON.stringify({ sentences: polishAnswer.sentences.map(({ text, cites }) => ({ text, cites })) }) };
    const written = await repositoryBriefPrompt(root, { definition: null, phase: polishAnswer.phase, workflow: { workItem: story }, changedPaths, polish: 'write', refresh: true, ask: async () => recorded });
    // Every sentence is kept or rejected with its text; none is kept when the answer failed as a whole.
    const rejectedTexts = new Set(written.polish.rejected.map((entry) => entry.text));
    const kept = written.polish.accepted ? polishAnswer.sentences.filter((sentence) => !rejectedTexts.has(sentence.text)) : [];
    const violations = kept.filter((sentence) => sentence.bad);
    polish = {
      phase: polishAnswer.phase, sent: written.polish.sent.length, sentences: polishAnswer.sentences.length,
      accepted: written.polish.accepted, rejected: written.polish.rejected.length,
      adversarial: polishAnswer.sentences.filter((sentence) => sentence.bad).length, violations: violations.length,
      rejections: written.polish.rejected.map((entry) => entry.reason), text: written.text
    };
  }
  return {
    name: spec.name, commit: knowledge.repository.commit, briefs,
    linking: linkPrecision(records, spec.labels?.links ?? []),
    statements: statementPrecision(documentation.statements, spec.labels?.statements ?? []),
    impact: impactRecall(impact, spec.labels?.impact ?? []),
    polish
  };
}

/** The measurements as a Markdown summary, one row per repository. */
export function benchmarkTable(results) {
  const percent = (value) => (value == null ? 'n/a' : `${Math.round(value * 100)}%`);
  const rows = results.map((result) => {
    const briefs = Object.values(result.briefs);
    const bytes = briefs.map((brief) => brief.bytes);
    const cited = briefs.reduce((sum, brief) => sum + brief.cited, 0) / Math.max(1, briefs.reduce((sum, brief) => sum + brief.statements, 0));
    const relevance = briefs.map((brief) => brief.relevance.score).filter((score) => score != null);
    return `| ${result.name} | ${Math.min(...bytes)}–${Math.max(...bytes)} | ${percent(cited)} | ${Math.max(...briefs.map((brief) => brief.notKnownLines))} | ${percent(result.linking.precision)} (${result.linking.correct}/${result.linking.links}; recall ${result.linking.found}/${result.linking.expected}) | ${percent(result.statements.precision)} (${result.statements.genuine}/${result.statements.extracted}) | ${percent(result.impact.recall)} (${result.impact.found}/${result.impact.expected}) | ${relevance.length ? percent(relevance.reduce((a, b) => a + b, 0) / relevance.length) : 'n/a'} | ${result.polish ? `${result.polish.violations} of ${result.polish.accepted} kept (${result.polish.adversarial} adversarial sent)` : 'n/a'} |`;
  });
  return [
    '| Repository | Brief bytes per phase | Statements cited | Most "Not known" lines | Rule linking precision | Doc statement precision | Impact recall | Relevant lines first | Polish: kept sentences that change a value or add a name |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows
  ].join('\n');
}

async function main(argv) {
  const value = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : null; };
  const repository = value('repository');
  const specFile = value('spec');
  if (!repository || !specFile) throw new Error('Usage: node scripts/world-model-v5-benchmark.mjs --repository PATH --spec FILE [--polish FILE] [--json]');
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  const polishFile = value('polish');
  const result = await measureRepository(path.resolve(repository), spec, { polishAnswer: polishFile ? JSON.parse(await readFile(polishFile, 'utf8')) : null });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(benchmarkTable([result]));
    for (const [phase, brief] of Object.entries(result.briefs)) console.log(`  ${phase} (${brief.profile}): ${brief.bytes}/${brief.budget} bytes, ${brief.cited}/${brief.statements} cited, ${brief.notKnownLines} Not known line(s), relevant first ${brief.relevance.score ?? 'n/a'}`);
    if (result.linking.wrong.length) console.log(`  links no label describes: ${result.linking.wrong.join(' | ')}`);
    if (result.statements.other.length) console.log(`  statements not labelled as rules: ${result.statements.other.join(' | ')}`);
    if (result.impact.missed.length) console.log(`  impact missed: ${result.impact.missed.join(', ')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
