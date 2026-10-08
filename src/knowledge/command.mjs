/**
 * `singularity-flow wm knowledge …`: build, read and score repository knowledge.
 *
 *   build   [--area PATH] [--refresh] [--json]                       analyse HEAD (cached by content)
 *   show    [VIEW] [--area PATH] [--focus TEXT] [--max-bytes N]       overview, rules, journeys, entities, tests, system, change
 *   slice   [--role ROLE | --phase PHASE] [--focus TEXT] [--max-bytes N]   what a phase prompt receives
 *   status  [--area PATH] [--json]                                    levels and counts
 *   items   [--kind KIND] [--area PATH] [--json]                      the typed items, for tools
 *   eval    --expected FILE [--area PATH] [--json]                    score against expectations
 *   confirm|correct|reject ID [--note TEXT]                           review an item (writes docs/knowledge/confirmations.yml)
 *   areas   [--json]                                                  the areas a large repository is built in
 *   explain [--area PATH] [--dry-run] [--json]                        plain-language explanations, citation-checked (needs a model; --dry-run shows the prompt)
 *
 * Read-only for the repository: it reads the committed tree and writes only its machine-local cache.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { operationContext } from '../operation-context.mjs';
import { optionBoolean, optionNumber, optionString, SingularityFlowError } from '../util.mjs';
import { applyReviews, readConfirmations, recordReview } from './confirm.mjs';
import { buildExplanationPrompt, explanationSubjects, readExplanations, validateExplanations, writeExplanations } from './explain.mjs';
import { parseKnowledgeExpectations, scoreKnowledge } from './benchmark.mjs';
import { KNOWLEDGE_KINDS } from './items.mjs';
import { KNOWLEDGE_ROLES, KNOWLEDGE_VIEWS, renderKnowledgeSlice, renderKnowledgeView, roleForPhase } from './render.mjs';
import { readKnowledgeSource } from './source.mjs';
import { buildKnowledge } from './store.mjs';
import { KNOWLEDGE_SOURCE_LIMITS } from './source.mjs';

const USAGE = 'Usage: singularity-flow wm knowledge <build|show|slice|status|items|eval|explain|areas|confirm|correct|reject> [--area PATH] [--json]';

async function built(root, options) {
  const result = await buildKnowledge(root, { area: optionString(options, 'area') ?? null, refresh: optionBoolean(options, 'refresh') });
  if (result.status !== 'ok') {
    const areas = (result.areas ?? []).slice(0, 12).map((area) => `${area.path || '.'} (${area.files})`).join(', ');
    throw new SingularityFlowError(
      `This repository has ${result.codeFiles} code files, more than one knowledge build reads. Build one area at a time with --area PATH${areas ? `, for example: ${areas}` : ''}. List them all with: singularity-flow wm knowledge areas. Phase prompts build the areas a Story changes or names on their own.`,
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
  if (!subcommand || !['build', 'show', 'slice', 'status', 'items', 'eval', 'explain', 'areas', 'confirm', 'correct', 'reject'].includes(subcommand)) throw new SingularityFlowError(USAGE);
  if (subcommand === 'areas') return areasCommand(root, options);
  const result = await built(root, options);
  if (['confirm', 'correct', 'reject'].includes(subcommand)) return reviewCommand(root, result, subcommand, positionals[1], options);
  // People's reviews (docs/knowledge/confirmations.yml) apply to everything shown below.
  const knowledge = applyReviews(result.knowledge, await readConfirmations(root));
  const maximumBytes = optionNumber(options, 'max-bytes') ?? null;
  const focus = optionString(options, 'focus') ?? null;
  const explanations = (await readExplanations(root, result.key))?.accepted ?? [];
  if (subcommand === 'explain') return explainCommand(root, result, options);

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
    const text = renderKnowledgeView(knowledge, view, { maximumBytes, focus, explanations });
    if (json) console.log(JSON.stringify({ view, bytes: Buffer.byteLength(text), markdown: text }, null, 2));
    else console.log(text);
    return { view, markdown: text };
  }
  if (subcommand === 'slice') {
    const phase = optionString(options, 'phase') ?? null;
    const role = optionString(options, 'role') ?? (phase ? roleForPhase(phase) : 'developer');
    if (!KNOWLEDGE_ROLES.includes(role)) throw new SingularityFlowError(`Unknown role '${role}'. Use one of: ${KNOWLEDGE_ROLES.join(', ')}.`);
    const text = renderKnowledgeSlice(knowledge, { role, focus, maximumBytes: maximumBytes ?? 8192, explanations });
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

/**
 * Ask the configured model to explain the knowledge in plain words, then keep only the sentences
 * whose code names, numbers and quoted texts are found in what they cite. Without a model (the
 * operation's never-model fallback) it says so; --dry-run prints the exact prompt instead.
 */
async function explainCommand(root, result, options) {
  const json = optionBoolean(options, 'json');
  const { knowledge } = result;
  const source = await readKnowledgeSource(root, { area: optionString(options, 'area') ?? null });
  const filesByPath = new Map([...source.files, ...source.manifests].map((file) => [file.path, file]));
  const subjects = explanationSubjects(knowledge);
  const prompt = buildExplanationPrompt(knowledge, subjects, filesByPath);
  if (optionBoolean(options, 'dry-run')) {
    if (json) console.log(JSON.stringify({ status: 'dry-run', subjects: subjects.map((subject) => ({ id: subject.id, title: subject.title, items: subject.items.length })), promptSha256: prompt.sha256, prompt: prompt.text }, null, 2));
    else console.log(prompt.text);
    return { status: 'dry-run' };
  }
  if (operationContext()?.operation?.id !== 'wm.knowledge.explain') {
    const message = 'Explanations need a model, and model execution is off for this command. The deterministic knowledge is unchanged; run with --dry-run to see what would be sent.';
    if (json) console.log(JSON.stringify({ status: 'unavailable', reason: 'model-disabled', message }, null, 2));
    else console.log(message);
    return { status: 'unavailable' };
  }
  const definition = await loadDefinition(root);
  const provider = resolveModelProvider(definition);
  const invocation = await invokeModel({
    provider: provider.provider,
    providerConfig: provider.providerConfig,
    model: provider.model,
    task: 'summarize',
    cwd: root,
    allowedRoots: [root],
    prompt: { text: prompt.text },
    channel: 'repository-knowledge-explanation',
    subject: { kind: 'repository-knowledge', id: knowledge.repository.name ?? 'repository' },
    tools: { mode: 'none', names: [] },
    limits: { timeoutMs: 4 * 60 * 1000, outputBytes: 256 * 1024 }
  });
  const checked = validateExplanations(invocation.output, subjects, prompt.evidence);
  const record = {
    knowledgeKey: result.key, promptSha256: prompt.sha256, model: provider.model ?? null, createdAt: new Date().toISOString(),
    accepted: checked.accepted, rejected: checked.rejected
  };
  await writeExplanations(root, result.key, record);
  const summary = { status: 'ok', accepted: checked.accepted.length, rejected: checked.rejected.length, rejections: checked.rejected };
  if (json) { console.log(JSON.stringify(summary, null, 2)); return summary; }
  console.log(`Kept ${checked.accepted.length} sentence${checked.accepted.length === 1 ? '' : 's'} that match their cited code; rejected ${checked.rejected.length}.`);
  for (const entry of checked.rejected.slice(0, 10)) console.log(`  rejected: "${entry.text}" (${entry.reason})`);
  console.log('Read them: singularity-flow wm knowledge show overview');
  return summary;
}

/** The areas this repository is built in: one whole build when it fits, otherwise one per area. */
async function areasCommand(root, options) {
  const json = optionBoolean(options, 'json');
  const source = await readKnowledgeSource(root, { listOnly: true });
  const areas = source.areas ?? [];
  const whole = source.codePaths <= KNOWLEDGE_SOURCE_LIMITS.maximumCodeFiles;
  const result = { codeFiles: source.codePaths, buildsWhole: whole, areas: areas.map((area) => ({ path: area.path || '.', files: area.files })) };
  if (json) { console.log(JSON.stringify(result, null, 2)); return result; }
  console.log(`${source.codePaths} code files: ${whole ? 'built whole' : `built one area at a time (over ${KNOWLEDGE_SOURCE_LIMITS.maximumCodeFiles})`}.`);
  for (const area of result.areas) console.log(`  ${area.path.padEnd(48)} ${area.files} files   wm knowledge build --area ${area.path}`);
  return result;
}

/** Record a person's review of one item in the working tree, to be committed with the code. */
async function reviewCommand(root, result, subcommand, id, options) {
  if (!id) throw new SingularityFlowError(`Usage: singularity-flow wm knowledge ${subcommand} <ITEM-ID> ${subcommand === 'confirm' ? '[--note TEXT]' : '--note TEXT'}`);
  const status = { confirm: 'confirmed', correct: 'corrected', reject: 'rejected' }[subcommand];
  const { entry, file } = await recordReview(root, result.knowledge, { id, status, note: optionString(options, 'note') ?? null });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ status: 'recorded', review: entry, file }, null, 2));
  else {
    console.log(`Recorded: ${entry.about ?? id} ${status}${entry.note ? ` (${entry.note})` : ''}.`);
    console.log(`Commit ${file} with your change so the review travels with the code.`);
  }
  return { entry, file };
}
