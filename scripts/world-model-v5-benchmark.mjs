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
 *
 * Real use [WMR:REQ-029]: how the briefs a team's Stories really carried did, and what today's code would give them.
 *
 *   node scripts/world-model-v5-benchmark.mjs --real-use --prompts DIR --worktrees DIR --repository CLONE
 *     [--replay SCRATCH-CLONE] [--json]
 *
 * `--prompts` is the prompt audit's folder (only its `prompts.jsonl` is read), `--worktrees` the folder of Story
 * worktrees holding each Story's records and receipts, and `--repository` a complete local clone (never a partial
 * one: the measure reads file contents and must not fetch) with the Stories' branches. See `measureRealUse`.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isCodeLanguage, isTestPath, languageOf } from '../src/code-intelligence/generated/code-explainer-model.mjs';
import { readDocumentation } from '../src/knowledge/brief.mjs';
import { phaseBriefProfile } from '../src/knowledge/phase-brief.mjs';
import { repositoryBriefPrompt, stepBriefSignals } from '../src/knowledge/prompt.mjs';
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

/**
 * Measure one repository against one spec. `calls: 'resolved'` reads every call as a compiler would have resolved it,
 * so the claims built on calls are stated as they are with a warmed semantic pack [WMR:REQ-014]; by default calls are
 * as built (matched by name in a fixture) and those claims are left out.
 */
export async function measureRepository(root, spec, { polishAnswer = null, calls = 'as-built' } = {}) {
  const trustCalls = calls === 'resolved' ? () => true : null;
  const story = { title: spec.story.title, description: spec.story.description ?? null, acceptanceCriteria: spec.story.acceptanceCriteria ?? [], baseCommit: 'HEAD' };
  const changedPaths = spec.change?.paths ?? [];
  const briefs = {};
  for (const phase of spec.phases) {
    const brief = await repositoryBriefPrompt(root, { definition: null, phase, workflow: { workItem: story }, changedPaths, polish: 'off', trustCalls });
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
    const written = await repositoryBriefPrompt(root, { definition: null, phase: polishAnswer.phase, workflow: { workItem: story }, changedPaths, polish: 'write', refresh: true, ask: async () => recorded, trustCalls });
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

// ---------------------------------------------------------------------------------------------------------------
// Real use [WMR:REQ-029]: the kept prompts of a team's Stories, measured against what each Story's final diff changed.
// It reads only its inputs, sends nothing anywhere and calls no model.

/** Story records, tool output and Git metadata: never a file a Story's change is measured by. */
const NOT_STORY_CODE = /^(?:singularity|\.singularity-flow|\.sflow|\.git|\.github)\/|(?:^|\/)(?:node_modules|dist|build|out|target|bin|obj|coverage|test-results|playwright-report|\.next|vendor)\//u;
const isStoryCode = (file) => !NOT_STORY_CODE.test(file) && isCodeLanguage(languageOf(file));

/** A brief's profile, as the kind of step it served. Hit rate is read over plan and code steps. */
const STEP_KINDS = Object.freeze({
  intake: 'intake', design: 'plan', 'implementation-spec': 'plan', reproduction: 'plan', implementation: 'code', review: 'review',
  verification: 'verify', conformance: 'release', release: 'release'
});
const KIND_ORDER = Object.freeze(['intake', 'plan', 'code', 'review', 'verify', 'release']);
const BRIEF_HEADER = /^# Repository brief: (.+?)(?: at ([0-9a-f]{7,40}))? \(for ([\w-]+)/u;
/** The branch the replay checks commits out on: loading a Story's configuration needs a branch, never a Story's own. */
const REPLAY_BRANCH = 'wmr-real-use-replay';
/** Git for the measure: never a fetch, a prompt, the person's own Git settings, or an optional lock. */
const GIT_ENV = Object.freeze({ GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

function git(repository, args, { input = undefined, buffer = false, allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    env: { ...process.env, ...GIT_ENV }, input, ...(buffer ? {} : { encoding: 'utf8' }), maxBuffer: 512 * 1024 * 1024
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} failed in ${repository}: ${String(result.stderr).trim()}`);
  return result.status === 0 ? (buffer ? result.stdout : result.stdout.trim()) : null;
}

/** A complete local clone only: a partial one would fetch, or fail, when a file's contents are read. */
function assertCompleteClone(repository, role) {
  if (git(repository, ['rev-parse', '--git-dir'], { allowFailure: true }) == null) throw new Error(`${role} ${repository} is not a Git repository.`);
  const partial = git(repository, ['config', '--get-regexp', '^(remote\\..*\\.promisor|extensions\\.partialclone)$'], { allowFailure: true });
  if (partial && partial.split('\n').some((line) => !/\sfalse$/u.test(line))) {
    throw new Error(`${role} ${repository} is a partial clone; measure a complete local copy: git clone --no-hardlinks ${repository} <scratch folder>`);
  }
}

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const lastName = (symbol) => String(symbol).split('.').pop();
const baseName = (file) => String(file).split('/').pop();

/** The brief a composed prompt carried, read the way `wm brief` reads it: from its header to the next top heading. */
export function promptBrief(prompt) {
  const lines = String(prompt ?? '').split('\n');
  const start = lines.findIndex((line) => line.startsWith('# Repository brief: '));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^# /u.test(line));
  const text = lines.slice(start, end < 0 ? undefined : end).join('\n').trimEnd();
  const header = BRIEF_HEADER.exec(lines[start]);
  return { text, bytes: Buffer.byteLength(text), repository: header?.[1] ?? null, commit: header?.[2] ?? null, profile: header?.[3] ?? null };
}

/** A brief without what names its checkout: the header line, the repository's label and the commits it cites. */
export function briefBody(text, repository = null) {
  let body = String(text ?? '').split('\n').slice(1).join('\n');
  if (repository) body = body.split(repository).join('<repository>');
  return body.replace(/\bcommit [0-9a-f]{7,40}\b/gu, 'commit <commit>');
}

const listed = (text) => String(text).split(/,\s*|\s+and\s+/u).map((entry) => entry.trim()).filter((entry) => entry && !/^\d+ more$/u.test(entry));

/**
 * The claims a brief makes about calls and tests [WMR:REQ-014]: "no test reaches it", "tested by", "called from N
 * places", "called by", "reached by N entry points", and a flow's caller → callee chain.
 */
export function briefClaims(text) {
  const claims = [];
  let section = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('## ')) { section = line.slice(3).trim(); continue; }
    if (!line.startsWith('- ') || line.startsWith('- …')) continue;
    const body = line.slice(2).replace(/^\(changed by this Story\) /u, '');
    if (section === 'Flows') {
      // What starts a flow (a request, an event) comes first; each function after it calls the next.
      const steps = body.split(/;| \(/u)[0].split(' → ').map((step) => step.trim());
      if (steps.length >= 3) claims.push({ kind: 'call-chain', subject: steps[1], chain: steps.slice(1), line });
      continue;
    }
    const colon = body.indexOf(': ');
    const named = colon > 0 ? body.slice(0, colon).replace(/ \((?:changed|planned|new, planned)\)$/u, '').trim() : null;
    const subject = named && !/\s/u.test(named) ? named : null;
    const rest = colon > 0 ? body.slice(colon + 2) : body;
    if (/\bno test reaches it\b/u.test(rest)) claims.push({ kind: 'no-test-reaches', subject, line });
    const tested = /\btested (through its callers )?by ([^;()]+?)\s*(?=;|\(|$)/u.exec(rest);
    if (tested) claims.push({ kind: 'tested-by', subject, files: listed(tested[2]), through: Boolean(tested[1]), line });
    const from = /\bcalled from (\d+) places\b/u.exec(rest);
    if (from) claims.push({ kind: 'called-from', subject, count: Number(from[1]), line });
    const by = /\bcalled by ([^;()]+?)\s*(?=;|\(|$)/u.exec(rest);
    if (by) claims.push({ kind: 'called-by', subject, callers: listed(by[1]), line });
    const reach = /\breached by (?:(\d+) entry points?|every endpoint)\b/u.exec(rest);
    if (reach) claims.push({ kind: 'reached-by', subject, count: reach[1] ? Number(reach[1]) : null, line });
  }
  return claims;
}

/**
 * How many times `text` calls `name`: never as part of a longer name or its own definition. A call on another object
 * (`math.evaluate(`) counts only with `member`; one on `this` or on a module the file imports by a relative path always
 * counts, since that is the repository's own function.
 */
function callCount(text, name, { member = false } = {}) {
  let count = 0;
  const definition = new RegExp(`^\\s*(?:(?:async|static|public|private|protected|export|default)\\s+)*${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*\\{\\s*$`, 'u');
  const ownModule = (qualifier) => {
    if (qualifier === 'this') return true;
    if (!qualifier) return false;
    const q = escapeRegExp(qualifier);
    return new RegExp(`\\bimport\\s+(?:\\*\\s+as\\s+)?${q}\\b[^;\\n]*?from\\s+['"]\\.|\\b${q}\\s*=\\s*require\\(\\s*['"]\\.`, 'u').test(text);
  };
  for (const match of text.matchAll(new RegExp(`${escapeRegExp(name)}\\s*\\(`, 'gu'))) {
    const before = text.slice(Math.max(0, match.index - 64), match.index);
    if (/[\w$]$/u.test(before)) continue;
    const qualifier = /([\w$]+)\s*\.\s*$/u.exec(before)?.[1] ?? (/\.\s*$/u.test(before) ? '' : null);
    if (qualifier !== null && !member && !ownModule(qualifier)) continue;
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    if (/(?:\bfunction\s*\*?\s*|\bdef\s+)$/u.test(text.slice(lineStart, match.index))) continue;
    const lineEnd = text.indexOf('\n', match.index);
    if (definition.test(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd))) continue;
    count += 1;
  }
  // A component is called where it is rendered.
  if (/^[A-Z]/u.test(name)) count += [...text.matchAll(new RegExp(`<${escapeRegExp(name)}[\\s/>]`, 'gu'))].length;
  return count;
}

function definesName(text, name) {
  const n = escapeRegExp(name);
  return new RegExp(`(?:\\bfunction\\s*\\*?\\s+${n}\\s*\\(|\\b(?:const|let|var)\\s+${n}\\s*=|\\bdef\\s+${n}\\s*\\(|\\bclass\\s+${n}\\b`
    + `|(?:^|[\\s{,])${n}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)`
    + `|^\\s*(?:(?:async|static|public|private|protected|export|default)\\s+)*${n}\\s*\\([^)]*\\)\\s*\\{)`, 'mu').test(text);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Whether the files where `caller` is defined call `callee`; null when no file defines it (nothing to contradict). */
function callerCalls(evidence, caller, callee) {
  const defining = evidence.sources.filter((file) => definesName(file.text, lastName(caller)));
  if (!defining.length) return null;
  return defining.some((file) => callCount(file.text, lastName(callee), { member: callee.includes('.') }) > 0);
}

/**
 * Whether the repository contradicts a claim, counted conservatively: "no test reaches it" is wrong only when a test
 * file at the brief's commit, or one the Story's final diff adds or changes, names the symbol (or imports the file);
 * "called from N places" only when the call sites are far off (none, or at least three times N and ten more); a named
 * caller or a flow's step only when the file that defines it never calls the next; "tested by" only when no such file
 * exists. Reach through entry points is counted, never judged. `wrong` is null when it cannot be judged.
 */
export function judgeClaim(claim, evidence) {
  const unjudged = { ...claim, wrong: null };
  // Without the brief's commit there is nothing to hold a claim against.
  if (!evidence.found || claim.kind === 'reached-by' || (!claim.subject && claim.kind !== 'tested-by')) return unjudged;
  if (claim.kind === 'no-test-reaches') {
    const file = claim.subject.includes('/');
    const name = file ? baseName(claim.subject).replace(/\.[^.]+$/u, '') : lastName(claim.subject);
    if (name.length < 3) return unjudged;
    const pattern = file
      ? new RegExp(`['"\`](?:[^'"\`\\n]*/)?${escapeRegExp(name)}(?:\\.[cm]?[jt]sx?)?['"\`]`, 'u')
      : new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'u');
    for (const test of evidence.tests) {
      const match = pattern.exec(test.text);
      if (match) return { ...claim, wrong: true, where: test.where, why: `${test.path}:${lineOf(test.text, match.index)} names ${name}` };
    }
    return { ...claim, wrong: false };
  }
  if (claim.kind === 'tested-by') {
    const missing = claim.files.filter((name) => !evidence.fileNames.has(name));
    return missing.length ? { ...claim, wrong: true, where: 'tree', why: `no file named ${missing.join(', ')}` } : { ...claim, wrong: false };
  }
  if (claim.kind === 'called-from') {
    const name = lastName(claim.subject);
    const sites = evidence.sources.reduce((sum, file) => sum + callCount(file.text, name, { member: claim.subject.includes('.') }), 0);
    // None at all: not even as another object's method, which a match by name could have taken for it.
    const none = evidence.sources.every((file) => callCount(file.text, name, { member: true }) === 0);
    const far = none || (sites >= 3 * claim.count && sites - claim.count >= 10);
    return { ...claim, wrong: far, sites, ...(far ? { where: 'tree', why: `${sites} call sites of ${name}, not ${claim.count}` } : {}) };
  }
  const hops = claim.kind === 'called-by' ? claim.callers.map((caller) => [caller, claim.subject])
    : claim.chain.slice(0, -1).map((caller, index) => [caller, claim.chain[index + 1]]);
  let judged = false;
  for (const [caller, callee] of hops) {
    if (/[\s<>]/u.test(caller) || /[\s<>]/u.test(callee)) continue;
    const calls = callerCalls(evidence, caller, callee);
    if (calls === false) return { ...claim, wrong: true, where: 'tree', why: `${caller} never calls ${lastName(callee)}` };
    if (calls === true) judged = true;
  }
  return judged ? { ...claim, wrong: false } : unjudged;
}

/** The changed files a brief names: by path, or by a file name only that file has. */
export function namedFiles(text, changed, uniqueNames) {
  const body = String(text ?? '').split('\n').slice(1).join('\n');
  const mentions = (needle) => new RegExp(`(?:^|[\\s(\`'"])${escapeRegExp(needle)}(?=$|[\\s):,;\`'"])`, 'mu').test(body);
  return changed.filter((file) => mentions(file) || (uniqueNames.has(baseName(file)) && mentions(baseName(file))));
}

/** The repository's files at a commit, with the text of its code and test files. */
function commitEvidence(repository, commit, cache) {
  if (cache.has(commit)) return cache.get(commit);
  const listing = git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit], { buffer: true, allowFailure: true });
  const entries = listing ? listing.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const [meta, file] = entry.split('\t');
    const [, type, oid] = meta.split(' ');
    return { type, oid, path: file };
  }).filter((entry) => entry.type === 'blob') : [];
  const code = entries.filter((entry) => isStoryCode(entry.path));
  const texts = readBlobs(repository, code.map((entry) => entry.oid));
  const files = code.map((entry) => ({ path: entry.path, text: texts.get(entry.oid) ?? '' }));
  const names = new Map();
  for (const entry of code) names.set(baseName(entry.path), (names.get(baseName(entry.path)) ?? 0) + 1);
  const value = {
    found: Boolean(listing), names, fileNames: new Set(entries.map((entry) => baseName(entry.path))),
    sources: files.filter((file) => !isTestPath(file.path)), tests: files.filter((file) => isTestPath(file.path)).map((file) => ({ ...file, where: 'tree' }))
  };
  cache.set(commit, value);
  return value;
}

/** Blob texts by the name asked for (an object name, or `<commit>:<path>`), read in one batch; a missing or large object is left out (never fetched). */
function readBlobs(repository, names) {
  const texts = new Map();
  const asked = [...new Set(names)];
  if (!asked.length) return texts;
  const output = git(repository, ['cat-file', '--batch'], { input: `${asked.join('\n')}\n`, buffer: true });
  let offset = 0;
  // Answers come in the order asked: "<object> <type> <size>" and the contents, or "<name> missing".
  for (const name of asked) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) break;
    const [, type, size] = output.subarray(offset, newline).toString('utf8').split(' ');
    offset = newline + 1;
    if (type === 'missing' || size === undefined) continue;
    const bytes = Number(size);
    if (type === 'blob' && bytes <= 1024 * 1024) texts.set(name, output.subarray(offset, offset + bytes).toString('utf8'));
    offset += bytes + 1;
  }
  return texts;
}

/** A Story's final change: the code files its branch changed from its base, and the text of the tests among them. */
function storyChange(repository, workflow) {
  const item = workflow?.workItem ?? {};
  const resolve = (reference) => (reference ? git(repository, ['rev-parse', '--verify', '-q', `${reference}^{commit}`], { allowFailure: true }) : null);
  const base = resolve(item.baseCommit) ?? resolve(item.baseBranch ? `refs/heads/${item.baseBranch}` : null);
  const head = resolve(item.branch ? `refs/heads/${item.branch}` : null);
  if (!base || !head) return { status: !base ? 'no-base' : 'no-branch', branch: item.branch ?? null, changed: [], tests: [], fileNames: new Set() };
  const diff = git(repository, ['diff', '--name-status', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
  const changed = [];
  for (let index = 0; index + 1 < diff.length; index += 2) if (isStoryCode(diff[index + 1])) changed.push({ status: diff[index], path: diff[index + 1] });
  const tests = changed.filter((entry) => entry.status !== 'D' && isTestPath(entry.path));
  const texts = readBlobs(repository, tests.map((entry) => `${head}:${entry.path}`));
  const listing = git(repository, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', head], { buffer: true });
  // The lead file: the code file, not a test, with the most lines added and removed.
  const lines = new Map(git(repository, ['diff', '--numstat', '--no-renames', '-z', base, head]).split('\0').filter(Boolean)
    .map((entry) => entry.split('\t')).map(([added, removed, file]) => [file, (Number(added) || 0) + (Number(removed) || 0)]));
  const lead = changed.filter((entry) => !isTestPath(entry.path)).map((entry) => entry.path).sort()
    .reduce((best, file) => ((lines.get(file) ?? 0) > (lines.get(best) ?? -1) ? file : best), null);
  return {
    status: 'ok', branch: item.branch, base, head, changed: changed.map((entry) => entry.path).sort(), lead,
    tests: tests.map((entry) => ({ path: entry.path, text: texts.get(`${head}:${entry.path}`) ?? '', where: 'diff' })),
    fileNames: new Set(listing.toString('utf8').split('\0').filter(Boolean).map(baseName))
  };
}

/** A Story record, or null when it is not there; a read the sandbox refuses is never mistaken for a missing file. */
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ERR_ACCESS_DENIED') throw error;
    return null;
  }
}

/**
 * The kept Story step prompts: rows of the prompt audit's `prompts.jsonl` with a Story, a step and the prompt text.
 * `prompts` is the audit folder or the file; nothing else in the folder is read.
 */
export async function readKeptPrompts(prompts) {
  const file = String(prompts).endsWith('.jsonl') ? prompts : path.join(prompts, 'prompts.jsonl');
  const rows = [];
  let skipped = 0;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { skipped += 1; continue; }
    if (typeof row?.workId === 'string' && row.workId && typeof row.phase === 'string' && row.phase !== 'unscoped' && typeof row.prompt === 'string') rows.push(row);
    else skipped += 1;
  }
  return { rows, skipped };
}

function stepKind(profile) {
  return STEP_KINDS[profile] ?? 'other';
}

function measureSide(side, evidence, story) {
  if (!side.text) return { ...side, named: [], claims: [] };
  return {
    ...side,
    named: story.status === 'ok' ? namedFiles(side.text, story.changed, evidence.uniqueNames) : [],
    claims: briefClaims(side.text).map((claim) => judgeClaim(claim, evidence))
  };
}

/** One side's numbers (kept or replayed) over a set of steps. */
function summarize(steps, side) {
  const entries = steps.map((step) => ({ step, value: step[side] })).filter((entry) => entry.value && entry.value.status !== 'not-replayable');
  const briefs = entries.filter((entry) => entry.value.text);
  const byKind = {};
  for (const kind of KIND_ORDER.concat('other')) {
    const own = briefs.filter((entry) => entry.step.kind === kind);
    if (own.length) byKind[kind] = { briefs: own.length, medianBytes: median(own.map((entry) => entry.value.bytes)) };
  }
  const noBrief = {};
  for (const { step, value } of entries.filter((entry) => !entry.value.text)) {
    const reason = value.reasonCode ?? 'UNKNOWN';
    noBrief[reason] ??= {};
    noBrief[reason][step.kind] = (noBrief[reason][step.kind] ?? 0) + 1;
  }
  // A plan or code step with no brief names nothing: it counts as a miss. `lead`: it names the file the Story changed most.
  const hit = { plan: { hit: 0, lead: 0, of: 0 }, code: { hit: 0, lead: 0, of: 0 }, noCodeChange: 0 };
  for (const { step, value } of entries.filter((entry) => ['plan', 'code'].includes(entry.step.kind))) {
    if (!step.storyChanged) { hit.noCodeChange += 1; continue; }
    hit[step.kind].of += 1;
    if (value.named?.length) hit[step.kind].hit += 1;
    if (step.lead && value.named?.includes(step.lead)) hit[step.kind].lead += 1;
  }
  const total = { hit: hit.plan.hit + hit.code.hit, lead: hit.plan.lead + hit.code.lead, of: hit.plan.of + hit.code.of };
  const claims = briefs.flatMap((entry) => entry.value.claims.map((claim) => ({ ...claim, step: entry.step.id })));
  const claimKinds = {};
  for (const claim of claims) {
    claimKinds[claim.kind] ??= { claims: 0, judged: 0, wrong: 0 };
    claimKinds[claim.kind].claims += 1;
    if (claim.wrong != null) claimKinds[claim.kind].judged += 1;
    if (claim.wrong) claimKinds[claim.kind].wrong += 1;
  }
  const wrong = claims.filter((claim) => claim.wrong);
  const groups = new Map();
  for (const { step, value } of briefs) {
    const key = briefBody(value.text, value.repository);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(step);
  }
  const identical = [...groups.values()].filter((group) => new Set(group.map((step) => step.story)).size > 1)
    .map((group) => ({ briefs: group.length, stories: new Set(group.map((step) => step.story)).size, kinds: [...new Set(group.map((step) => step.kind))] }))
    .sort((a, b) => b.briefs - a.briefs);
  return {
    steps: entries.length, briefs: briefs.length,
    hitRate: { ...hit, all: { ...total, rate: total.of ? total.hit / total.of : null } },
    claims: {
      total: claims.length, judged: claims.filter((claim) => claim.wrong != null).length, wrong: wrong.length, byKind: claimKinds,
      wrongWhere: { tree: wrong.filter((claim) => claim.where === 'tree').length, diff: wrong.filter((claim) => claim.where === 'diff').length }
    },
    bytes: {
      median: median(briefs.map((entry) => entry.value.bytes)), total: briefs.reduce((sum, entry) => sum + entry.value.bytes, 0),
      shareOfPromptMedian: median(briefs.map((entry) => entry.value.bytes / entry.value.promptBytes)), byKind
    },
    noBrief: { steps: entries.length - briefs.length, byReason: noBrief },
    identical: { briefs: identical.reduce((sum, group) => sum + group.briefs, 0), groups: identical }
  };
}

/**
 * Re-compose each kept step's brief with today's code [WMR:REQ-029], from the same commit and so the same plan and
 * changed files: the commit is checked out in `clone` (a scratch clone, on a branch of its own) and the Story's pinned
 * configuration and records are read there, as compose reads them. `loadStory(root, { workId, phase })` returns
 * `{ definition, workflow }` (by default compose's own `loadPromptConfig`). Only `clone` is written: its checkout, its
 * branch and its machine-local caches. A step that cannot be re-composed exactly is "not replayable", with why.
 */
export async function replayBriefs(steps, { clone, loadStory = null, log = () => {} }) {
  assertCompleteClone(clone, 'The replay clone');
  // It checks commits out and removes what is not committed: a clone with anything of its own in its checkout is refused.
  if (git(clone, ['status', '--porcelain', '--ignored'])) throw new Error(`The replay clone ${clone} has uncommitted, untracked or ignored files; replay needs a clean scratch clone.`);
  // Parsed YAML would otherwise be kept in the machine's temporary folder: the replay writes only into the clone.
  const yamlCache = process.env.SINGULARITY_FLOW_YAML_CACHE;
  process.env.SINGULARITY_FLOW_YAML_CACHE = 'off';
  const composer = await import('../src/phase-prompt-composer.mjs');
  const load = loadStory ?? (async (root, { workId, phase }) => {
    const config = await composer.loadPromptConfig(root, { workId, phase });
    return { definition: config.definition, workflow: config.workflow };
  });
  const original = git(clone, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true }) ?? git(clone, ['rev-parse', 'HEAD']);
  const done = new Map();
  const results = new Map();
  try {
    for (const step of steps) {
      const commit = step.kept.commit ? git(clone, ['rev-parse', '--verify', '-q', `${step.kept.commit}^{commit}`], { allowFailure: true }) : null;
      const key = `${commit}\0${step.story}\0${step.phase}`;
      if (!done.has(key)) {
        done.set(key, await (async () => {
          if (!step.kept.commit) return { status: 'not-replayable', why: 'the kept prompt names no commit (it carried no brief)' };
          if (!commit) return { status: 'not-replayable', why: `commit ${step.kept.commit} is not in the clone` };
          if (git(clone, ['checkout', '-q', '--force', '-B', REPLAY_BRANCH, commit], { allowFailure: true }) == null) {
            return { status: 'not-replayable', why: `commit ${step.kept.commit} could not be checked out (objects missing)` };
          }
          git(clone, ['clean', '-fdxq']);
          let story;
          try { story = await load(clone, { workId: step.story, phase: step.phase }); } catch (error) {
            return { status: 'not-replayable', why: `the Story's pinned configuration could not be read at that commit: ${String(error?.message ?? error).split('\n')[0]}` };
          }
          if (story?.workflow?.workItem?.id !== step.story) return { status: 'not-replayable', why: 'the Story\'s records are not at that commit' };
          if (!story.workflow.phases?.[step.phase]) return { status: 'not-replayable', why: `the Story has no step ${step.phase} at that commit` };
          const brief = await composer.phaseRepositoryBrief(clone, { definition: story.definition, workflow: story.workflow, phase: step.phase, polish: 'off' });
          const header = brief.text ? BRIEF_HEADER.exec(brief.text.split('\n')[0]) : null;
          return {
            status: 'ok', text: brief.text, bytes: Buffer.byteLength(brief.text ?? ''), profile: brief.profile ?? null,
            repository: header?.[1] ?? null, reasonCode: brief.text ? null : brief.reasonCode ?? brief.status ?? 'UNKNOWN',
            warnings: brief.warnings ?? []
          };
        })());
        log(`replayed ${done.size}: ${step.phase} → ${done.get(key).status}`);
      }
      results.set(step.id, done.get(key));
    }
  } finally {
    git(clone, ['checkout', '-q', '--force', original], { allowFailure: true });
    git(clone, ['branch', '-q', '-D', REPLAY_BRANCH], { allowFailure: true });
    if (yamlCache === undefined) delete process.env.SINGULARITY_FLOW_YAML_CACHE;
    else process.env.SINGULARITY_FLOW_YAML_CACHE = yamlCache;
  }
  return results;
}

/**
 * The real-use measure [WMR:REQ-029]. Reads the kept prompts (`prompts`), each Story's records and receipts in its
 * worktree (`worktrees`/<worktree>/singularity/work-items/<id>/), and the Story's final diff from `repository`, a
 * complete clone with the Stories' branches. With `replay` (a scratch clone, which may be `repository` itself) each
 * step's brief is re-composed with today's code and measured the same way, so kept (before) and replayed (after) are
 * the same Stories' steps. Returns the per-step measures and both sides' summaries.
 */
export async function measureRealUse({ prompts, worktrees, repository, replay = null, loadStory = null, log = () => {} }) {
  assertCompleteClone(repository, 'The repository');
  const { rows, skipped } = await readKeptPrompts(prompts);
  const stories = new Map();
  const commits = new Map();
  const steps = [];
  for (const [index, row] of rows.entries()) {
    const worktree = path.basename(String(row.repositoryPath ?? ''));
    const itemFolder = path.join(worktrees, worktree, 'singularity', 'work-items', row.workId);
    const storyKey = `${worktree}\0${row.workId}`;
    if (!stories.has(storyKey)) {
      const workflow = await readJson(path.join(itemFolder, 'workflow.json'));
      stories.set(storyKey, { id: row.workId, worktree, workflow, ...(workflow ? storyChange(repository, workflow) : { status: 'no-records', changed: [], tests: [], fileNames: new Set() }) });
    }
    const story = stories.get(storyKey);
    const receipt = await readJson(path.join(itemFolder, 'context', `${row.phase}-gen${row.generation}.json`));
    const brief = promptBrief(row.prompt);
    const signals = story.workflow ? stepBriefSignals({ workflow: story.workflow, phase: row.phase }) : {};
    const profile = brief?.profile ?? receipt?.repositoryBrief?.profile ?? phaseBriefProfile(row.phase, signals).id;
    const promptBytes = Buffer.byteLength(row.prompt);
    steps.push({
      id: index + 1, recordedAt: row.recordedAt ?? null, story: row.workId, worktree, phase: row.phase, generation: row.generation ?? null,
      kind: stepKind(profile), storyChanged: story.changed.length > 0, lead: story.lead ?? null,
      receipt: receipt ? {
        matchesPrompt: Boolean(receipt.compositionCache?.key) && receipt.compositionCache.key === row.compositionCache?.key,
        renderer: receipt.repositoryBrief?.renderer ?? null, profile: receipt.repositoryBrief?.profile ?? null,
        budget: receipt.repositoryBrief?.budget ?? null, bytes: receipt.repositoryBrief?.bytes ?? null,
        reasonCode: receipt.groundingAvailability?.reasonCode ?? null, files: Array.isArray(receipt.files) ? receipt.files.length : null
      } : null,
      kept: brief ? { ...brief, promptBytes, reasonCode: null }
        : { text: '', bytes: 0, promptBytes, commit: null, profile: receipt?.repositoryBrief?.profile ?? null,
          reasonCode: receipt ? (receipt.repositoryBrief ? 'BRIEF_NOT_IN_PROMPT' : receipt.groundingAvailability?.reasonCode ?? 'UNKNOWN') : 'NO_RECEIPT' }
    });
  }
  const replayed = replay ? await replayBriefs(steps, { clone: replay, loadStory, log }) : null;
  for (const step of steps) {
    const story = stories.get(`${step.worktree}\0${step.story}`);
    const evidenceFor = (commit) => {
      const atCommit = commit ? commitEvidence(repository, commit, commits) : { found: false, names: new Map(), fileNames: new Set(), sources: [], tests: [] };
      const uniqueNames = new Set([...story.changed.map(baseName)].filter((name) => (atCommit.names.get(name) ?? 0) <= 1
        && story.changed.filter((file) => baseName(file) === name).length === 1));
      return {
        found: atCommit.found, sources: atCommit.sources, tests: [...atCommit.tests, ...story.tests],
        fileNames: new Set([...atCommit.fileNames, ...story.fileNames]), uniqueNames
      };
    };
    const commit = step.kept.commit ? git(repository, ['rev-parse', '--verify', '-q', `${step.kept.commit}^{commit}`], { allowFailure: true }) : null;
    const evidence = evidenceFor(commit);
    step.kept = measureSide(step.kept, evidence, story);
    if (replayed) {
      const result = replayed.get(step.id);
      step.replayed = result.status === 'ok' ? measureSide({ ...result, commit: step.kept.commit, promptBytes: step.kept.promptBytes - step.kept.bytes + result.bytes }, evidence, story) : result;
    }
  }
  const dates = steps.map((step) => step.recordedAt).filter(Boolean).sort();
  const replayable = steps.filter((step) => step.replayed?.status === 'ok');
  return {
    mode: 'real-use',
    input: { prompts: rows.length, skipped, steps: steps.length, stories: new Set(steps.map((step) => step.story)).size, from: dates[0] ?? null, to: dates.at(-1) ?? null },
    kept: summarize(steps, 'kept'),
    keptReplayable: replayed && replayable.length !== steps.length ? summarize(replayable, 'kept') : null,
    replayed: replayed ? summarize(steps, 'replayed') : null,
    notReplayable: replayed ? steps.filter((step) => step.replayed.status !== 'ok').map((step) => ({ step: step.id, story: step.story, phase: step.phase, why: step.replayed.why })) : null,
    stories: [...stories.values()].map((story) => ({
      id: story.id, worktree: story.worktree, status: story.status, branch: story.branch ?? null, changed: story.changed, lead: story.lead ?? null,
      tests: story.tests.map((test) => test.path)
    })),
    steps
  };
}

/** The measure as text a person reads: kept (before) beside replayed (after). */
export function realUseReport(result) {
  const percent = (part, whole) => (whole ? `${part} of ${whole} (${Math.round((part / whole) * 100)}%)` : 'none to measure');
  const sides = [['kept (before)', result.kept], ...(result.replayed ? [['replayed (after)', result.replayed]] : [])];
  const kinds = KIND_ORDER.concat('other').filter((kind) => sides.some(([, side]) => side.bytes.byKind[kind] || Object.values(side.noBrief.byReason).some((entry) => entry[kind])));
  const noBrief = (side) => (side.noBrief.steps ? `${side.noBrief.steps}: ${Object.entries(side.noBrief.byReason)
    .map(([reason, byKind]) => `${reason} (${Object.entries(byKind).map(([kind, n]) => `${kind} ${n}`).join(', ')})`).join('; ')}` : '0');
  const claimKinds = [...new Set(sides.flatMap(([, side]) => Object.keys(side.claims.byKind)))].sort();
  const rows = [
    ['Plan and code steps whose brief names a file the Story changed', ...sides.map(([, side]) => percent(side.hitRate.all.hit, side.hitRate.all.of))],
    ['  plan', ...sides.map(([, side]) => percent(side.hitRate.plan.hit, side.hitRate.plan.of))],
    ['  code', ...sides.map(([, side]) => percent(side.hitRate.code.hit, side.hitRate.code.of))],
    ['  naming the file the Story changed most', ...sides.map(([, side]) => percent(side.hitRate.all.lead, side.hitRate.all.of))],
    ['  not counted: the Story changed no code file', ...sides.map(([, side]) => String(side.hitRate.noCodeChange))],
    ['Wrong claims (of claims judged; claims made)', ...sides.map(([, side]) => `${side.claims.wrong} of ${side.claims.judged}; ${side.claims.total}`)],
    ...claimKinds.map((kind) => [`  ${kind}`, ...sides.map(([, side]) => {
      const entry = side.claims.byKind[kind];
      return entry ? `${entry.wrong} of ${entry.judged}; ${entry.claims}` : '0';
    })]),
    ['Steps with a brief', ...sides.map(([, side]) => `${side.briefs} of ${side.steps}`)],
    ['Brief bytes per step (median)', ...sides.map(([, side]) => String(side.bytes.median ?? 'n/a'))],
    ...kinds.map((kind) => [`  ${kind}`, ...sides.map(([, side]) => (side.bytes.byKind[kind] ? `${side.bytes.byKind[kind].medianBytes} (${side.bytes.byKind[kind].briefs} briefs)` : 'no brief'))]),
    ['Brief share of the step prompt (median)', ...sides.map(([, side]) => (side.bytes.shareOfPromptMedian == null ? 'n/a' : `${(side.bytes.shareOfPromptMedian * 100).toFixed(1)}%`))],
    ['Steps with no brief, and why', ...sides.map(([, side]) => noBrief(side))],
    ['Briefs identical across Stories (header removed)', ...sides.map(([, side]) => (side.identical.briefs
      ? `${side.identical.briefs} (${side.identical.groups.map((group) => `${group.briefs} ${group.kinds.join('/')} of ${group.stories} Stories`).join('; ')})` : '0'))]
  ];
  const width = Math.max(...rows.map((row) => row[0].length)) + 2;
  const column = Math.max(18, ...rows.flatMap((row) => row.slice(1, -1).map((cell) => cell.length))) + 2;
  const lines = [
    `Real-use measure of the Repository brief [WMR:REQ-029]: ${result.input.steps} step prompts of ${result.input.stories} Stories`
      + `${result.input.from ? `, ${result.input.from.slice(0, 10)} to ${result.input.to.slice(0, 10)}` : ''}`
      + `${result.input.skipped ? ` (${result.input.skipped} other prompts skipped)` : ''}. Nothing was sent; no model was called.`,
    '',
    `${''.padEnd(width)}${sides.map(([title], index) => (index < sides.length - 1 ? title.padEnd(column) : title)).join('')}`,
    ...rows.map(([label, ...cells]) => `${label.padEnd(width)}${cells.map((cell, index) => (index < cells.length - 1 ? cell.padEnd(column) : cell)).join('')}`)
  ];
  if (result.keptReplayable) {
    const kept = result.keptReplayable;
    lines.push('', `Kept, on the replayable steps only: hit ${percent(kept.hitRate.all.hit, kept.hitRate.all.of)}, wrong claims ${kept.claims.wrong} of ${kept.claims.judged}, median ${kept.bytes.median} bytes.`);
  }
  if (result.notReplayable?.length) {
    lines.push('', `Not replayable: ${result.notReplayable.length}`);
    const reasons = new Map();
    for (const entry of result.notReplayable) reasons.set(entry.why, (reasons.get(entry.why) ?? 0) + 1);
    for (const [why, count] of reasons) lines.push(`  ${count}: ${why}`);
  }
  const wrong = result.steps.flatMap((step) => [['kept', step.kept], ['replayed', step.replayed]]
    .filter(([, side]) => side?.claims).flatMap(([side, value]) => value.claims.filter((claim) => claim.wrong).map((claim) => `${side} ${claim.kind} ${claim.subject ?? ''}: ${claim.why} (${claim.where})`)));
  if (wrong.length) {
    lines.push('', 'Wrong claims, each once:');
    for (const [text, count] of [...wrong.reduce((map, text) => map.set(text, (map.get(text) ?? 0) + 1), new Map())]) lines.push(`  ${text}${count > 1 ? ` ×${count}` : ''}`);
  }
  return lines.join('\n');
}

async function main(argv) {
  const value = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : null; };
  if (argv.includes('--real-use')) {
    const [prompts, worktrees, repository, replay] = ['prompts', 'worktrees', 'repository', 'replay'].map(value);
    if (!prompts || !worktrees || !repository) {
      throw new Error('Usage: node scripts/world-model-v5-benchmark.mjs --real-use --prompts DIR --worktrees DIR --repository CLONE [--replay SCRATCH-CLONE] [--json] [--verbose]');
    }
    const result = await measureRealUse({
      prompts: path.resolve(prompts), worktrees: path.resolve(worktrees), repository: path.resolve(repository), replay: replay ? path.resolve(replay) : null,
      log: argv.includes('--verbose') ? (line) => process.stderr.write(`${line}\n`) : () => {}
    });
    console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : realUseReport(result));
    return;
  }
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
