/**
 * Spec drift: does the code still say what an approved specification bound it to? [spec-code sync]
 *
 * A closed Story's code-delivery receipt names, for each clause, the source lines tagged
 * `@clause` for it, the hunks its delivery changed and the acceptance test that witnesses it, all
 * as of the generation commit its approval bound. Later commits can rewrite that code, drop the tag
 * or the test, or bring back something the Story removed, and nothing noticed. This compares each
 * closed Story's bound code and tests, from that commit to now:
 *
 * - `in-sync`: the tags are there and the bound lines and acceptance tests are unchanged;
 * - `drifted`: a bound line, an acceptance test or a planned deletion changed;
 * - `orphaned`: every tag, or every acceptance test, of the clause is gone;
 * - `unverifiable`: the approved commit is not in this clone or the receipt cannot be read.
 *
 * A person resolves a drifted clause (src/commands/spec-drift.mjs `decide`): accept it, bound to the
 * bytes accepted; adopt it, the specification following the code through a named Story; or restore
 * it, the code following the specification through a named Story. Those decisions live in
 * `singularity/spec-drift/<WORK-ID>.json` beside, never inside, the closed Story's records.
 *
 * It is advisory. The report refuses nothing and writes nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { commitPresent, commitsChangingSince, fileAtRef, pathPatchSince } from './git.mjs';
import { readRecord } from './schema-migrations.mjs';
import { scanSourceClauseTags } from './source-clause-tags.mjs';
import { SingularityFlowError } from './util.mjs';
import { scanJavaScriptDeclarations } from './verification/javascript-declarations.mjs';

export const DRIFT_STATUSES = Object.freeze(['in-sync', 'drifted', 'orphaned', 'unverifiable', 'accepted', 'resolving', 'adopted', 'restored']);
export const DRIFT_OUTCOMES = Object.freeze(['accept', 'adopt', 'restore']);
const RESOLVED = Object.freeze({ adopt: 'adopted', restore: 'restored' });

/** Where a closed Story's drift decisions are kept: beside its records, never inside them. */
export function driftDecisionsPath(workId) {
  return `singularity/spec-drift/${workId}.json`;
}
const JAVASCRIPT = /\.(?:[cm]?[jt]sx?|[cm][jt]s)$/iu;
// Without an exact test declaration, a tagged test is taken to run from its tag to the next one.
const FALLBACK_TEST_LINES = 60;

/**
 * A `--unified=0` patch, by path: deleted or added, and the changed line ranges in the old file's
 * coordinates. A pure insertion after line N is `{ start: N, end: N, insertion: true }`.
 */
export function parseZeroContextPatch(text) {
  const files = new Map();
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('--- ')) {
      current = { path: line === '--- /dev/null' ? null : line.slice(6).replace(/\t$/u, ''), deleted: false, added: line === '--- /dev/null', ranges: [] };
      continue;
    }
    if (line.startsWith('+++ ') && current) {
      if (line === '+++ /dev/null') current.deleted = true;
      current.path ??= line.slice(6).replace(/\t$/u, '');
      files.set(current.path, current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.ranges.push(count === 0 ? { start, end: start, insertion: true } : { start, end: start + count - 1 });
    }
  }
  return files;
}

/** Whether a changed range touches the lines `from`..`to`; an insertion counts when it lands inside them. */
export function rangeTouches(range, from, to) {
  if (range.insertion) return range.start >= from && range.start < to;
  return range.start <= to && range.end >= from;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The Stories recorded in this checkout, readable ones only, by Work ID. */
export function recordedStories(root, workItemRoot = 'singularity/work-items') {
  const directory = path.join(root, workItemRoot);
  const stories = [];
  let names = [];
  try { names = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return stories; }
  for (const name of names) {
    const file = path.join(directory, name, 'workflow.json');
    if (!existsSync(file)) continue;
    try {
      stories.push(readRecord('story-workflow', JSON.parse(readFileSync(file, 'utf8'))).record);
    } catch {
      stories.push({ workItem: { id: name }, unreadable: true });
    }
  }
  return stories;
}

/** The clauses one approved code delivery bound, with the anchors drift checks for each. */
function boundClauses(receipt) {
  const clauses = new Map();
  const of = (clauseId) => {
    if (!clauses.has(clauseId)) clauses.set(clauseId, { clauseId, tags: [], deletions: [], regions: [], witnesses: [] });
    return clauses.get(clauseId);
  };
  for (const binding of receipt?.traceability?.sourceBindings ?? []) {
    if (!binding?.clauseId || !binding.sourcePath) continue;
    if (binding.tag === 'deletion') of(binding.clauseId).deletions.push({ path: binding.sourcePath });
    else of(binding.clauseId).tags.push({ path: binding.sourcePath, line: binding.line ?? null });
  }
  for (const binding of receipt?.implementationBindings?.bindings ?? []) {
    for (const region of binding?.regions ?? []) {
      if (!region?.path || region.change === 'deleted') continue;
      for (const hunk of region.hunks ?? []) {
        if (!(Number(hunk?.afterLines) > 0)) continue;
        of(binding.clauseId).regions.push({ path: region.path, from: Number(hunk.afterStart), to: Number(hunk.afterStart) + Number(hunk.afterLines) - 1 });
      }
    }
  }
  for (const witness of receipt?.traceability?.witnesses ?? []) {
    if (!witness?.clauseId || !witness.testSource) continue;
    of(witness.clauseId).witnesses.push(witness);
  }
  return [...clauses.values()];
}

/**
 * Compare closed Stories' approved code and tests with `ref` (a commit) or the working tree (null).
 * `workId` limits it to one Story, of any status; `stories` lets a caller pass what it already read.
 */
export function evaluateSpecDrift(root, { workItemRoot = 'singularity/work-items', workId = null, ref = null, stories = null } = {}) {
  const read = (relative) => {
    if (ref) {
      const text = fileAtRef(root, ref, relative);
      return text == null ? null : Buffer.from(text, 'utf8');
    }
    try { return readFileSync(path.join(root, relative)); } catch { return null; }
  };
  const contents = new Map();
  const content = (relative) => {
    if (!contents.has(relative)) contents.set(relative, read(relative));
    return contents.get(relative);
  };
  const report = [];
  const recorded = stories ?? recordedStories(root, workItemRoot);
  let everyStory = stories ? null : recorded;
  const storyById = (id) => (everyStory ??= recordedStories(root, workItemRoot)).find((entry) => entry.workItem?.id === id) ?? null;
  for (const workflow of recorded) {
    const id = workflow.workItem?.id;
    if (workId ? id !== workId : workflow.status !== 'closed') continue;
    if (workflow.unreadable) {
      report.push({ workId: id, title: null, status: 'unreadable', clauses: [], findings: [{ code: 'story-unreadable', message: `${id}'s workflow.json could not be read.` }] });
      continue;
    }
    const story = { workId: id, title: workflow.workItem.title ?? null, status: workflow.status, clauses: [], findings: [] };
    for (const phaseId of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
      const phase = workflow.phases?.[phaseId];
      if (!phase || phase.status !== 'approved') continue;
      // An approved specification or plan whose bytes changed after the Story closed.
      for (const artifact of phase.artifacts ?? []) {
        if (artifact?.kind !== 'document' || !artifact.path || !/^[0-9a-f]{64}$/u.test(String(artifact.sha256 ?? ''))) continue;
        const bytes = content(artifact.path);
        if (!bytes) story.findings.push({ code: 'approved-artifact-missing', phase: phaseId, path: artifact.path,
          message: `The approved ${phaseId} document ${artifact.path} is gone.` });
        else if (sha256(bytes) !== artifact.sha256) story.findings.push({ code: 'approved-artifact-changed', phase: phaseId, path: artifact.path,
          message: `The approved ${phaseId} document ${artifact.path} changed after approval.` });
      }
      const evidence = phase.deliveryEvidence;
      if (evidence?.status !== 'ready' || !evidence.receiptPath) continue;
      let receipt = null;
      try { receipt = readRecord('code-delivery', JSON.parse(content(evidence.receiptPath)?.toString('utf8') ?? 'null')).record; } catch { receipt = null; }
      const baseline = receipt?.tree?.generationCommit ?? phase.generationCommit ?? null;
      const clauses = receipt ? boundClauses(receipt) : [];
      if (!receipt || !commitPresent(root, baseline)) {
        const reason = !receipt ? `the ${phaseId} code-delivery receipt cannot be read`
          : `the approved ${phaseId} commit ${String(baseline ?? '').slice(0, 8)} is not in this clone; fetch the Story branch`;
        story.findings.push({ code: 'delivery-unverifiable', phase: phaseId, message: `Drift cannot be checked: ${reason}.` });
        for (const clause of clauses) story.clauses.push({ clauseId: clause.clauseId, phase: phaseId, status: 'unverifiable', findings: [] });
        continue;
      }
      const paths = [...new Set(clauses.flatMap((clause) => [
        ...clause.tags.map((entry) => entry.path), ...clause.deletions.map((entry) => entry.path),
        ...clause.regions.map((entry) => entry.path), ...clause.witnesses.map((entry) => entry.testSource)
      ]))].sort();
      const patch = pathPatchSince(root, baseline, ref, paths);
      if (patch == null) {
        story.findings.push({ code: 'delivery-unverifiable', phase: phaseId, message: `Drift cannot be checked: Git could not compare ${String(baseline).slice(0, 8)} with ${ref ?? 'the working tree'}.` });
        for (const clause of clauses) story.clauses.push({ clauseId: clause.clauseId, phase: phaseId, status: 'unverifiable', findings: [] });
        continue;
      }
      const changes = parseZeroContextPatch(patch);
      const commits = (relative) => commitsChangingSince(root, baseline, [relative], { target: ref ?? 'HEAD' })
        .map((entry) => ({ commit: entry.commit.slice(0, 8), subject: entry.subject }));
      const decisions = readDriftDecisions(content(driftDecisionsPath(id)));
      for (const clause of clauses) {
        story.clauses.push(applyDriftDecision(evaluateClause(clause, { phaseId, changes, content, commits }),
          decisions, { root, content, storyById }));
      }
    }
    report.push(story);
  }
  const clauses = report.flatMap((story) => story.clauses);
  const count = (status) => clauses.filter((entry) => entry.status === status).length;
  return {
    target: ref ?? 'the working tree',
    stories: report,
    summary: {
      stories: report.length, clauses: clauses.length, 'in-sync': count('in-sync'), drifted: count('drifted'),
      orphaned: count('orphaned'), unverifiable: count('unverifiable'), accepted: count('accepted'),
      resolving: count('resolving'), adopted: count('adopted'), restored: count('restored'),
      storyFindings: report.reduce((total, story) => total + story.findings.length, 0)
    }
  };
}

function evaluateClause(clause, { phaseId, changes, content, commits }) {
  const findings = [];
  const id = clause.clauseId;
  // Code: the tag and the hunks the delivery bound to this clause.
  let lostTags = 0;
  for (const tag of clause.tags) {
    const bytes = content(tag.path);
    const present = bytes && scanSourceClauseTags(bytes.toString('utf8'), { sourcePath: tag.path })
      .some((entry) => entry.tag === 'clause' && entry.clauseId === id);
    if (!bytes) { lostTags += 1; findings.push({ code: 'bound-file-deleted', path: tag.path, message: `${tag.path} is gone.` }); }
    else if (!present) { lostTags += 1; findings.push({ code: 'tag-missing', path: tag.path, message: `@clause:${id} is no longer in ${tag.path}.` }); }
  }
  for (const deletion of clause.deletions) {
    if (content(deletion.path)) findings.push({ code: 'deleted-path-restored', path: deletion.path,
      message: `${deletion.path} was removed for ${id} and exists again.`, commits: commits(deletion.path) });
  }
  const changedRegions = new Map();
  for (const region of clause.regions) {
    const change = changes.get(region.path);
    if (!change || change.deleted) continue;
    const touched = change.ranges.filter((range) => rangeTouches(range, region.from, region.to));
    if (!touched.length) continue;
    const entry = changedRegions.get(region.path) ?? { from: region.from, to: region.to };
    entry.from = Math.min(entry.from, region.from);
    entry.to = Math.max(entry.to, region.to);
    changedRegions.set(region.path, entry);
  }
  for (const [relative, lines] of changedRegions) {
    if (findings.some((entry) => entry.path === relative && entry.code === 'bound-file-deleted')) continue;
    findings.push({ code: 'bound-code-changed', path: relative, lines,
      message: `Lines ${lines.from}-${lines.to} of ${relative} that delivered ${id} changed.`, commits: commits(relative) });
  }
  // Tests: the acceptance test that witnessed this clause.
  let lostWitnesses = 0;
  for (const witness of clause.witnesses) {
    const result = witnessDrift(witness, { changes, content });
    if (!result) continue;
    if (result.lost) lostWitnesses += 1;
    findings.push({ ...result.finding, ...(result.finding.code === 'acceptance-test-changed' || result.finding.code === 'acceptance-region-changed'
      ? { commits: commits(witness.testSource) } : {}) });
  }
  const orphaned = (clause.tags.length > 0 && lostTags === clause.tags.length)
    || (clause.witnesses.length > 0 && lostWitnesses === clause.witnesses.length);
  return {
    clauseId: id, phase: phaseId,
    status: orphaned ? 'orphaned' : findings.length ? 'drifted' : 'in-sync',
    paths: [...new Set([...clause.tags.map((entry) => entry.path), ...clause.deletions.map((entry) => entry.path),
      ...clause.regions.map((entry) => entry.path), ...clause.witnesses.map((entry) => entry.testSource)])].sort(),
    productPaths: [...new Set([...clause.tags.map((entry) => entry.path), ...clause.regions.map((entry) => entry.path)])].sort(),
    testPaths: [...new Set(clause.witnesses.map((entry) => entry.testSource))].sort(),
    anchors: { tags: clause.tags.length, regions: clause.regions.length, witnesses: clause.witnesses.length, deletions: clause.deletions.length },
    findings
  };
}

/** Whether one acceptance test still exists, still carries the tag and still has its approved text. */
function witnessDrift(witness, { changes, content }) {
  const bytes = content(witness.testSource);
  const name = witness.identity?.name ? `'${witness.identity.name}'` : 'the acceptance test';
  if (!bytes) return { lost: true, finding: { code: 'acceptance-test-missing', path: witness.testSource,
    message: `${witness.testSource} with ${name} for ${witness.clauseId} is gone.` } };
  const text = bytes.toString('utf8');
  if (witness.exact && witness.logicalTestId && witness.identity?.framework && JAVASCRIPT.test(witness.testSource)) {
    let declaration = null;
    try {
      declaration = scanJavaScriptDeclarations(text, { sourcePath: witness.testSource, framework: witness.identity.framework })
        .declarations.find((entry) => entry.logicalTestId === witness.logicalTestId) ?? null;
    } catch { declaration = null; }
    if (!declaration) return { lost: true, finding: { code: 'acceptance-test-missing', path: witness.testSource,
      message: `${name} in ${witness.testSource}, which verified ${witness.clauseId}, is gone or renamed.` } };
    if (!declaration.clauseIds?.includes(witness.clauseId)) return { lost: true, finding: { code: 'acceptance-tag-missing', path: witness.testSource,
      message: `${name} in ${witness.testSource} no longer carries @ac:${witness.clauseId}.` } };
    if (witness.declarationSha256 && declaration.declarationSha256 !== witness.declarationSha256) return { lost: false, finding: {
      code: 'acceptance-test-changed', path: witness.testSource, message: `${name} in ${witness.testSource}, which verified ${witness.clauseId}, changed.` } };
    return null;
  }
  // Without an exact declaration: the tag must remain, and the lines it introduces must be unchanged.
  const tags = scanSourceClauseTags(text, { sourcePath: witness.testSource }).filter((entry) => entry.tag === 'ac');
  if (!tags.some((entry) => entry.clauseId === witness.clauseId)) return { lost: true, finding: { code: 'acceptance-tag-missing',
    path: witness.testSource, message: `@ac:${witness.clauseId} is no longer in ${witness.testSource}.` } };
  const change = changes.get(witness.testSource);
  const from = Number(witness.line) || null;
  if (change && from && change.ranges.some((range) => rangeTouches(range, Math.max(1, from - 1), from + FALLBACK_TEST_LINES))) {
    return { lost: false, finding: { code: 'acceptance-region-changed', path: witness.testSource,
      message: `The test at ${witness.testSource}:${from} that verified ${witness.clauseId} may have changed (the lines after its tag changed).` } };
  }
  return null;
}

/** The paths one Story's approved deliveries bound to its clauses, read from its receipts. */
function storyBoundPaths(root, workflow) {
  const paths = new Set();
  for (const phaseId of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
    const evidence = workflow.phases?.[phaseId]?.deliveryEvidence;
    if (workflow.phases[phaseId].status !== 'approved' || evidence?.status !== 'ready' || !evidence.receiptPath) continue;
    let receipt = null;
    try { receipt = JSON.parse(readFileSync(path.join(root, evidence.receiptPath), 'utf8')); } catch { continue; }
    for (const clause of boundClauses(receipt)) {
      for (const entry of [...clause.tags, ...clause.deletions, ...clause.regions]) paths.add(entry.path);
      for (const witness of clause.witnesses) paths.add(witness.testSource);
    }
  }
  return [...paths];
}

/**
 * Clauses of other closed Stories that this Story's change, from its base commit to the working
 * tree, makes drift: advisories only. The change may well be right; the other Story's clause then
 * reads drifted until a person adopts it (amends the clause) or restores the code.
 */
export function foreignClauseAdvisories(root, { workItemRoot = 'singularity/work-items', workflow, baseCommit, maximum = 20 }) {
  if (!commitPresent(root, baseCommit)) return [];
  const others = recordedStories(root, workItemRoot)
    .filter((story) => !story.unreadable && story.status === 'closed' && story.workItem?.id !== workflow?.workItem?.id)
    .map((story) => ({ story, paths: storyBoundPaths(root, story) }))
    .filter((entry) => entry.paths.length);
  if (!others.length) return [];
  const patch = pathPatchSince(root, baseCommit, null, [...new Set(others.flatMap((entry) => entry.paths))].sort());
  if (!patch) return [];
  const touched = new Set(parseZeroContextPatch(patch).keys());
  const relevant = others.filter((entry) => entry.paths.some((candidate) => touched.has(candidate))).map((entry) => entry.story);
  if (!relevant.length) return [];
  const key = (finding) => `${finding.code}\u0000${finding.path ?? ''}`;
  const before = new Map();
  for (const story of evaluateSpecDrift(root, { workItemRoot, stories: relevant, ref: baseCommit }).stories) {
    for (const clause of story.clauses) before.set(`${story.workId}\u0000${clause.clauseId}`, new Set(clause.findings.map(key)));
  }
  const advisories = [];
  for (const story of evaluateSpecDrift(root, { workItemRoot, stories: relevant, ref: null }).stories) {
    for (const clause of story.clauses) {
      const earlier = before.get(`${story.workId}\u0000${clause.clauseId}`) ?? new Set();
      for (const finding of clause.findings.filter((entry) => !earlier.has(key(entry)))) {
        advisories.push(Object.freeze({
          code: 'spec.drift.foreign-clause', category: 'coverage', blocking: false, requiredBefore: null,
          path: finding.path ?? null, line: finding.lines?.from ?? null, value: clause.clauseId,
          workId: story.workId, clauseId: clause.clauseId, drift: clause.status,
          message: `This change touches ${clause.clauseId} of closed Story ${story.workId}: ${finding.message} That clause will read ${clause.status} until a person adopts it or restores the code. If this Story's specification should take it over, draft that: singularity-flow story intent-amendment draft --adopt ${clause.clauseId}. Advisory only.`
        }));
      }
    }
  }
  return advisories.slice(0, maximum);
}

/** A Story's drift decisions, oldest first; an unreadable file is no decision at all. */
export function readDriftDecisions(bytes) {
  if (!bytes) return [];
  try {
    const parsed = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    return Array.isArray(parsed?.decisions) ? parsed.decisions.filter((entry) => entry && typeof entry === 'object') : [];
  } catch {
    return [];
  }
}

/** The latest decision on a clause that has not been revoked, or null. */
export function activeDriftDecision(decisions, clauseId) {
  const revoked = new Set(decisions.filter((entry) => entry.revokes).map((entry) => entry.revokes));
  return [...decisions].reverse().find((entry) => !entry.revokes && entry.clauseId === clauseId && !revoked.has(entry.id)) ?? null;
}

/** The file digests a decision binds: null for a path that does not exist. */
export function boundFileDigests(paths, content) {
  return Object.fromEntries(paths.map((relative) => {
    const bytes = content(relative);
    return [relative, bytes ? sha256(bytes) : null];
  }));
}

function sameDigests(recorded, paths, content) {
  const now = boundFileDigests(paths, content);
  return paths.length > 0 && paths.every((relative) => Object.hasOwn(recorded ?? {}, relative) && recorded[relative] === now[relative]);
}

/**
 * The clause as a person's decision leaves it. Drift that a decision covers keeps its findings and
 * reads accepted, resolving, adopted or restored; drift that happened after the decision does not.
 */
function applyDriftDecision(result, decisions, { root, content, storyById }) {
  if (!['drifted', 'orphaned'].includes(result.status)) return result;
  const decision = activeDriftDecision(decisions, result.clauseId);
  if (!decision) return result;
  const reference = { id: decision.id, outcome: decision.outcome, story: decision.story ?? null, actor: decision.actor,
    at: decision.at, reason: decision.reason };
  if (decision.outcome === 'accept') {
    return sameDigests(decision.observed?.files, result.paths, content)
      ? { ...result, rawStatus: result.status, status: 'accepted', decision: reference }
      : { ...result, decision: { ...reference, overtaken: true }, findings: [...result.findings, { code: 'decision-overtaken',
        message: `The code or test changed again after ${decision.id} accepted the drift.` }] };
  }
  const resolver = decision.story ? storyById(decision.story) : null;
  if (!resolver || resolver.unreadable || resolver.status !== 'closed') {
    return { ...result, rawStatus: result.status, status: 'resolving', decision: reference };
  }
  // Resolved: the code matches what the resolving Story last approved, until it changes again.
  const commit = (resolver.phaseOrder ?? []).map((id) => resolver.phases?.[id])
    .filter((phase) => phase?.status === 'approved' && phase.generationCommit).at(-1)?.generationCommit ?? null;
  const approved = commit ? Object.fromEntries(result.paths.map((relative) => {
    const text = fileAtRef(root, commit, relative);
    return [relative, text == null ? null : sha256(Buffer.from(text, 'utf8'))];
  })) : null;
  if (approved && sameDigests(approved, result.paths, content)) {
    return { ...result, rawStatus: result.status, status: RESOLVED[decision.outcome], decision: reference };
  }
  return { ...result, decision: { ...reference, overtaken: true }, findings: [...result.findings, { code: 'decision-overtaken',
    message: `The code or test changed after ${decision.story}, which ${RESOLVED[decision.outcome]} the clause, closed.` }] };
}

/**
 * Record a decision on one drifted clause in a Story's decision file (returned, not written).
 * `clause` is the clause as `evaluateSpecDrift` reports it now.
 */
export function recordDriftDecision(file, { workId, clause, outcome, story = null, reason, actor, authorityGroup,
  identityAssurance = null, at, content }) {
  if (!['drifted', 'orphaned'].includes(clause?.rawStatus ?? clause?.status)) {
    throw new SingularityFlowError(`${clause?.clauseId ?? 'This clause'} is ${clause?.status ?? 'unknown'}; only a drifted or orphaned clause is decided.`, {
      code: 'SPEC_DRIFT_NOT_DRIFTED' });
  }
  if (!DRIFT_OUTCOMES.includes(outcome)) throw new SingularityFlowError(`Choose one of --${DRIFT_OUTCOMES.join(', --')}.`, { code: 'SPEC_DRIFT_DECISION_INVALID' });
  if (outcome !== 'accept' && !/^[A-Z][A-Z0-9]*-\d+$/u.test(String(story ?? ''))) {
    throw new SingularityFlowError(`--${outcome} names the Story that will ${outcome} it with --story WORK-ID.`, { code: 'SPEC_DRIFT_DECISION_INVALID' });
  }
  if (outcome === 'accept' && story) throw new SingularityFlowError('--accept takes no --story.', { code: 'SPEC_DRIFT_DECISION_INVALID' });
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why in 20 to 1000 characters with --reason.', { code: 'SPEC_DRIFT_DECISION_INVALID' });
  }
  const decisions = [...(file?.decisions ?? [])];
  const decision = {
    id: `DRD-${String(decisions.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    clauseId: clause.clauseId, phase: clause.phase, outcome, ...(story ? { story } : {}), reason: text,
    observed: { status: clause.rawStatus ?? clause.status, findings: clause.findings.map((finding) => finding.code),
      files: boundFileDigests(clause.paths ?? [], content) },
    actor, authorityGroup, identityAssurance, at
  };
  decisions.push(decision);
  return { file: { schemaVersion: 1, workId, decisions }, decision };
}

/** Revoke a decision; the record stays, and so does the revocation. */
export function recordDriftRevocation(file, { workId, decisionId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const decisions = [...(file?.decisions ?? [])];
  const target = decisions.find((entry) => !entry.revokes && entry.id === decisionId);
  if (!target) throw new SingularityFlowError(`${workId} has no drift decision ${decisionId}.`, { code: 'SPEC_DRIFT_DECISION_UNKNOWN' });
  if (decisions.some((entry) => entry.revokes === decisionId)) throw new SingularityFlowError(`${decisionId} is already revoked.`, { code: 'SPEC_DRIFT_DECISION_REVOKED' });
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why in 20 to 1000 characters with --reason.', { code: 'SPEC_DRIFT_DECISION_INVALID' });
  }
  const revocation = { revokes: decisionId, clauseId: target.clauseId, reason: text, actor, authorityGroup, identityAssurance, at };
  decisions.push(revocation);
  return { file: { schemaVersion: 1, workId, decisions }, decision: revocation };
}
