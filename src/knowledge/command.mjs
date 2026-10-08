/**
 * `singularity-flow wm knowledge …`: build, read and score repository knowledge.
 *
 *   build   [--area PATH] [--refresh] [--json]                       analyse HEAD (cached by content)
 *   show    [VIEW] [--area PATH] [--focus TEXT] [--max-bytes N]       overview, rules, journeys, entities, tests, system, change
 *   slice   [--role ROLE | --phase PHASE] [--focus TEXT] [--max-bytes N]   what a phase prompt receives
 *   status  [--area PATH] [--json]                                    levels and counts
 *   items   [--kind KIND] [--area PATH] [--json]                      the typed items, for tools
 *   eval    --expected FILE [--area PATH] [--json]                    score against expectations
 *
 * Read-only for the repository: it reads the committed tree and writes only its machine-local cache.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { optionBoolean, optionNumber, optionString, SingularityFlowError } from '../util.mjs';
import { parseKnowledgeExpectations, scoreKnowledge } from './benchmark.mjs';
import { KNOWLEDGE_KINDS } from './items.mjs';
import { KNOWLEDGE_ROLES, KNOWLEDGE_VIEWS, renderKnowledgeSlice, renderKnowledgeView, roleForPhase } from './render.mjs';
import { buildKnowledge } from './store.mjs';

const USAGE = 'Usage: singularity-flow wm knowledge <build|show|slice|status|items|eval> [--area PATH] [--json]';

async function built(root, options) {
  const result = await buildKnowledge(root, { area: optionString(options, 'area') ?? null, refresh: optionBoolean(options, 'refresh') });
  if (result.status !== 'ok') {
    const areas = (result.areas ?? []).slice(0, 12).map((area) => `${area.path || '.'} (${area.files})`).join(', ');
    throw new SingularityFlowError(
      `This repository has ${result.codeFiles} code files, more than one knowledge build reads. Build one area at a time with --area PATH${areas ? `, for example: ${areas}` : ''}.`,
      { code: 'KNOWLEDGE_SCOPE_TOO_LARGE', details: { codeFiles: result.codeFiles, areas: result.areas } }
    );
  }
  return result;
}

function levelLine(levels) {
  return Object.entries(levels).map(([level, value]) => `${level} ${value.status}`).join(' · ');
}

export async function knowledgeCommand(root, positionals, options) {
  const subcommand = positionals[0];
  const json = optionBoolean(options, 'json');
  if (!subcommand || !['build', 'show', 'slice', 'status', 'items', 'eval'].includes(subcommand)) throw new SingularityFlowError(USAGE);
  const result = await built(root, options);
  const { knowledge } = result;
  const maximumBytes = optionNumber(options, 'max-bytes') ?? null;
  const focus = optionString(options, 'focus') ?? null;

  if (subcommand === 'build' || subcommand === 'status') {
    const summary = {
      status: 'ok', commit: knowledge.repository.commit, area: knowledge.repository.area, cache: result.cache, durationMs: result.durationMs,
      files: knowledge.repository.files, frameworks: knowledge.repository.frameworks, levels: knowledge.levels, metrics: knowledge.metrics,
      areas: knowledge.areas
    };
    if (json) { console.log(JSON.stringify(summary, null, 2)); return summary; }
    console.log(`Knowledge for ${knowledge.repository.name ?? 'repository'} at ${String(knowledge.repository.commit).slice(0, 12)}${knowledge.repository.area ? ` (area ${knowledge.repository.area})` : ''}: ${knowledge.metrics.items} items from ${knowledge.repository.files} code files (${result.cache === 'hit' ? 'cached' : `built in ${result.durationMs} ms`}).`);
    console.log(`  Levels: ${levelLine(knowledge.levels)}`);
    for (const [level, value] of Object.entries(knowledge.levels)) if (value.status !== 'ready') console.log(`  ${level}: ${value.reason}`);
    const kinds = knowledge.metrics.byKind;
    console.log(`  ${kinds.rule ?? 0} rules, ${kinds.limit ?? 0} limits, ${kinds['entry-point'] ?? 0} entry points, ${kinds.journey ?? 0} journeys, ${kinds.entity ?? 0} data shapes, ${kinds['test-case'] ?? 0} test cases, ${kinds['untested-rule'] ?? 0} untested functions with rules, ${kinds.drift ?? 0} test/code disagreements.`);
    console.log(`  Citations: ${knowledge.metrics.citations}, ${knowledge.metrics.invalidCitations} invalid. Calls: ${knowledge.metrics.calls} (${knowledge.metrics.callsMatchedByName} matched by name).`);
    console.log('  Read it: singularity-flow wm knowledge show [overview|rules|journeys|entities|tests|system|change]');
    return summary;
  }
  if (subcommand === 'show') {
    const view = positionals[1] ?? 'overview';
    if (!KNOWLEDGE_VIEWS.includes(view)) throw new SingularityFlowError(`Unknown knowledge view '${view}'. Use one of: ${KNOWLEDGE_VIEWS.join(', ')}.`);
    const text = renderKnowledgeView(knowledge, view, { maximumBytes, focus });
    if (json) console.log(JSON.stringify({ view, bytes: Buffer.byteLength(text), markdown: text }, null, 2));
    else console.log(text);
    return { view, markdown: text };
  }
  if (subcommand === 'slice') {
    const phase = optionString(options, 'phase') ?? null;
    const role = optionString(options, 'role') ?? (phase ? roleForPhase(phase) : 'developer');
    if (!KNOWLEDGE_ROLES.includes(role)) throw new SingularityFlowError(`Unknown role '${role}'. Use one of: ${KNOWLEDGE_ROLES.join(', ')}.`);
    const text = renderKnowledgeSlice(knowledge, { role, focus, maximumBytes: maximumBytes ?? 8192 });
    if (json) console.log(JSON.stringify({ role, phase, bytes: Buffer.byteLength(text), markdown: text }, null, 2));
    else console.log(text);
    return { role, markdown: text };
  }
  if (subcommand === 'items') {
    const kind = optionString(options, 'kind') ?? null;
    if (kind && !KNOWLEDGE_KINDS.includes(kind)) throw new SingularityFlowError(`Unknown item kind '${kind}'. Use one of: ${KNOWLEDGE_KINDS.join(', ')}.`);
    const items = knowledge.items.filter((item) => !kind || item.kind === kind);
    if (json) console.log(JSON.stringify({ count: items.length, items }, null, 2));
    else for (const item of items) console.log(`${item.id}  ${item.level} ${item.kind.padEnd(19)} ${item.assurance.padEnd(8)} ${item.citations[0] ? `${item.citations[0].path}:${item.citations[0].lines[0]}` : item.subject?.path ?? ''}`);
    return { items };
  }
  // eval
  const expectedPath = optionString(options, 'expected');
  if (!expectedPath) throw new SingularityFlowError('wm knowledge eval needs --expected FILE (a YAML list of what the repository contains).');
  const expectations = parseKnowledgeExpectations(await readFile(path.resolve(expectedPath), 'utf8'));
  const score = scoreKnowledge(knowledge, expectations);
  if (json) { console.log(JSON.stringify(score, null, 2)); return score; }
  console.log(`Knowledge score${score.name ? ` for ${score.name}` : ''}: ${score.found}/${score.expected} expected items found (${Math.round(score.recall * 100)}%). Citations valid: ${Math.round(score.citationValidity * 100)}%.`);
  for (const [level, value] of Object.entries(score.levels)) console.log(`  ${level}: ${value.found}/${value.expected} (${Math.round(value.recall * 100)}%)`);
  for (const [category, value] of Object.entries(score.categories)) {
    console.log(`  ${category}: ${value.found}/${value.expected}`);
    for (const missed of value.missed) console.log(`    missed: ${JSON.stringify(missed)}`);
  }
  return score;
}
