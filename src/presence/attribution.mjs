/**
 * SF Guard part 2, G3 [SPEC-SFG-v1 §7 and §8, REQ-040 to REQ-042, REQ-050, AC-008 to AC-010]: the
 * labels a person sees beside the work, and where they show.
 *
 * - At submission the Story's change set is reconciled (G2) and a small `attribution` block (counts
 *   per class and the top items) joins the review packet, so `reviewPacketSha256`, which an SF Guard
 *   approval signs, seals it. Each line settles against the declared set of the step that wrote it.
 * - The approval card, the review, the evidence receipt, the final check and `guard report` read that
 *   block. The receipt and the remote check also confirm the packet file still holds the bytes the
 *   approval sealed (AC-009).
 *
 * Allow but label (REQ-042): a label never refuses, prompts or holds anything. A label that cannot be
 * computed says so and the step goes on. A repository that never opted in gets no block at all.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../records.mjs';

export const SF_GUARD_ATTRIBUTION_SCHEMA = 'sfg-attribution/1';
const CLASSES = Object.freeze(['declared', 'outside-workflow', 'unknown-agent', 'shell', 'unattributed', 'pre-guard']);
const TOP_ITEMS = 8;
const CARD_ITEMS = 3;
const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A block's own digest: everything but `sha256` itself. */
export function attributionDigest(block) {
  const { sha256: _ignored, ...rest } = block ?? {};
  return digest(rest);
}

const sealed = (block) => Object.freeze({ ...block, sha256: attributionDigest(block) });

/**
 * Whether `relative` is one of the Story's own records an SFlow command wrote (its workflow.json,
 * context, submissions, approvals), which carry their own provenance and are left out of the packet's
 * labels. The step's artifacts stay in: an agent writes those.
 */
export function governedRecordPath(relative, { workItemRoot, workId }) {
  const file = String(relative).replaceAll('\\', '/');
  if (file.startsWith('.sflow/')) return true;
  if (!workId) return false;
  const prefix = `${String(workItemRoot ?? 'singularity/work-items').replaceAll('\\', '/').replace(/\/+$/u, '')}/${workId}/`;
  return file.startsWith(prefix) && !file.slice(prefix.length).startsWith('artifacts/');
}

/** The resolved step `stepId` of `workflow`: its resolution entry with the phase's own state. */
function resolvedStep(workflow, stepId) {
  if (!workflow || !stepId) return null;
  const resolution = workflow.resolution?.phases?.find((entry) => entry.id === stepId) ?? null;
  const phase = workflow.phases?.[stepId] ?? null;
  return resolution || phase ? { id: stepId, ...(resolution ?? {}), ...(phase ?? {}) } : null;
}

/**
 * Reconcile the change set here [REQ-030], as `guard reconcile` does: a Story checkout against the
 * Story's base with its current step's declared set, anywhere else the working tree and unpushed
 * commits with the repository's. `perStep` settles each record against the step it names;
 * `excludeGoverned` leaves the Story's own SFlow records out. Reads Git a fixed three times.
 */
export async function reconcileHere(root, { definition, policy, workflow = null, excludeGoverned = false, perStep = false } = {}) {
  const [{ sfGuardChangeSet }, reconcile, { sfGuardDeclaredSet }, xpl2, recorder, { loadSkillLibrary }, { loadAgentMappings }] = await Promise.all([
    import('../git.mjs'), import('./reconcile.mjs'), import('./declared-set.mjs'), import('../comprehension/xpl2/observed-writes.mjs'),
    import('../comprehension/xpl2/sf-guard-recorder.mjs'), import('../skill-library.mjs'), import('../agents.mjs')]);
  const stepId = workflow?.currentPhase ?? null;
  const library = await loadSkillLibrary(root).catch(() => ({ skills: new Map() }));
  const mappings = await loadAgentMappings(root, { agents: definition?.agentCatalog ?? [] }).catch(() => ({ mappings: {} }));
  const setOf = (phase) => sfGuardDeclaredSet({ agents: definition?.agentCatalog ?? [], librarySkills: [...library.skills.keys()],
    mappings: mappings.mappings, phase });
  const declared = setOf(resolvedStep(workflow, stepId));
  const sets = new Map();
  const declaredFor = perStep && workflow ? (subject) => {
    const step = subject?.workId === workflow.workItem?.id ? subject?.phase ?? null : null;
    if (!step || step === stepId) return null;
    if (!sets.has(step)) sets.set(step, resolvedStep(workflow, step) ? setOf(resolvedStep(workflow, step)) : null);
    return sets.get(step);
  } : null;
  const phase = resolvedStep(workflow, stepId);
  // The Story's base: its work interval's source base, else the step's baseline, else the commit the
  // Story started from (a specification step has neither, and its branch is already pushed).
  const base = workflow ? workflow.workIntervals?.current?.sourceBaseCommit ?? phase?.generationIntent?.baseline?.commit
    ?? workflow.workItem?.baseCommit ?? null : null;
  const read = reconcile.workingTreeReader(root);
  const changes = sfGuardChangeSet(root, base);
  const governed = { workItemRoot: definition?.workItemRoot, workId: workflow?.workItem?.id ?? null };
  const files = [...reconcile.parseZeroContextPatch(changes.patch), ...await reconcile.untrackedAsAdded(changes.untracked, read)]
    .filter((file) => !excludeGoverned || !governedRecordPath(file.path, governed));
  const repository = await recorder.sfGuardRepository(root);
  const writes = repository ? (await xpl2.readObservedWrites(repository.gitDir, { paths: files.map((file) => file.path) }).catch(() => ({ records: [] }))).records : [];
  const shellRecords = await recorder.readSfGuardShellRecords(root).catch(() => []);
  const enabled = [...(policy?.chain?.events ?? [])].slice(0, policy?.folded?.validLength ?? 0).reverse()
    .find((event) => event.kind === 'enable' || event.kind === 'disable');
  const guardOnAt = enabled?.kind === 'enable' ? Date.parse(enabled.at) : null;
  const pin = workflow?.resolution?.presence ?? null;
  const report = await reconcile.reconcileChangeSet({ files, readCurrent: read, writes, shellRecords, declared, declaredFor,
    guardOnAt: Number.isFinite(guardOnAt) ? guardOnAt : null, pinnedOff: Boolean(workflow) && (!pin || pin.status !== 'required') });
  return { scope: workflow ? { kind: 'story', workId: workflow.workItem?.id ?? null, step: stepId, base: changes.base } : { kind: 'repository', base: changes.base },
    sfGuard: policy?.folded?.enabled ? 'on' : 'off', declared: { agents: declared.agents, skills: declared.skills }, ...report };
}

/**
 * The packet's `attribution` block from a reconcile `report`: counts per class, the top non-declared
 * items (by class, agent and skill), and the authorship it is shown beside. Small by design: the full
 * ranges come from `guard reconcile` and `guard report --story`.
 */
export function attributionBlock(report, { pin = null, authorship = null, claim = null } = {}) {
  const counts = Object.fromEntries(CLASSES.map((name) => [name, Number(report.counts?.[name] ?? 0)]));
  const groups = new Map();
  for (const range of report.ranges ?? []) {
    if (range.classification === 'declared' || range.classification === 'unattributed' || range.classification === 'pre-guard') continue;
    const key = JSON.stringify([range.classification, range.agent ?? null, range.skill ?? null, range.continued === true]);
    const group = groups.get(key) ?? { classification: range.classification, agent: range.agent ?? null, skill: range.skill ?? null,
      ...(range.continued ? { continued: true } : {}), lines: 0, files: new Set(), agentFilesChanged: false };
    group.lines += range.end - range.start + 1;
    group.files.add(range.path);
    if (range.agentFilesChanged) group.agentFilesChanged = true;
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((left, right) => right.lines - left.lines || CLASSES.indexOf(left.classification) - CLASSES.indexOf(right.classification));
  const items = ordered.slice(0, TOP_ITEMS).map(({ files, agentFilesChanged, ...item }) => ({ ...item, files: files.size,
    ...(agentFilesChanged ? { agentFilesChanged: true } : {}) }));
  // A claimed person's or tool's draft that records show an agent wrote: both are shown [REQ-041].
  const agentLines = counts.declared + counts['outside-workflow'] + counts['unknown-agent'];
  const producer = authorship?.producer ?? null;
  // SPEC-PSS-v1 §10.7: on a Story SF Guard requires, whether the claim carries its author's signature.
  const signing = claim ? (claim.signed ? { signed: true, signer: claim.signer ?? null } : { signed: false }) : {};
  const contradiction = ['human', 'external-tool'].includes(producer) && agentLines > 0 ? { claimed: producer, agentLines, ...signing } : null;
  return sealed({
    schema: SF_GUARD_ATTRIBUTION_SCHEMA, status: report.partial ? 'partial' : 'complete', pin: pin?.status ?? 'none',
    base: report.scope?.base ?? null, lines: report.lines ?? 0, files: report.files ?? 0, removed: report.removed ?? 0, counts,
    items, itemsOmitted: Math.max(0, ordered.length - items.length), rangesOmitted: report.rangesOmitted ?? 0,
    partial: report.partial ?? null, ...(contradiction ? { authorship: contradiction } : {})
  });
}

/** A block that could not be computed: shown as unavailable, never as "all declared". */
export function unavailableAttribution(reason, { pin = null } = {}) {
  return sealed({ schema: SF_GUARD_ATTRIBUTION_SCHEMA, status: 'unavailable', pin: pin?.status ?? 'none', reason: String(reason ?? 'unknown').slice(0, 200) });
}

/**
 * The block a step's review packet carries, or null when SF Guard does not apply here: the Story was
 * pinned `required`, or the repository has SF Guard on now (a Story pinned before it then reads
 * `pre-guard`). Never throws: a failure is an `unavailable` block, and the submission goes on.
 */
export async function storyAttributionBlock(root, config, workflow, phase) {
  const pin = workflow?.resolution?.presence ?? null;
  try {
    const recorder = await import('../comprehension/xpl2/sf-guard-recorder.mjs');
    const repository = await recorder.sfGuardRepository(root);
    const on = repository ? (await recorder.sfGuardOn(repository)).on : false;
    if (pin?.status !== 'required' && !on) return null;
    const policy = await (await import('./store.mjs')).readPresencePolicy(root);
    const report = await reconcileHere(root, { definition: config, policy, workflow, excludeGoverned: true, perStep: true });
    const authorship = [...(phase?.authorship ?? [])].reverse().find((record) => record.generation === phase.generation) ?? null;
    let claim = null;
    if (authorship && pin?.status === 'required' && ['human', 'external-tool'].includes(authorship.producer)) {
      const { authorshipClaimVerdict, loadPresenceContext } = await import('./person-records.mjs');
      const context = await loadPresenceContext(root, workflow);
      const verdict = authorshipClaimVerdict(context, authorship, { workflow, phase: phase?.id ?? null, generation: phase?.generation ?? null });
      claim = verdict.counts ? { signed: true, signer: authorship.presence?.approver ?? null } : { signed: false };
    }
    return attributionBlock(report, { pin, authorship, claim });
  } catch (error) {
    return unavailableAttribution(error?.message ?? error, { pin });
  }
}

function skillWords(item) {
  return item.skill ? `${item.skill}${item.continued ? ' (continued)' : ''}` : 'none';
}

/** One item in REQ-040's wording. */
function itemLabel(item) {
  const where = `${plural(item.lines, 'line')}${item.files ? ` in ${plural(item.files, 'file')}` : ''}`;
  const drift = item.agentFilesChanged ? ' [agent files changed]' : '';
  if (item.classification === 'outside-workflow') return `Produced outside the workflow: agent ${item.agent ?? 'none'}, skill ${skillWords(item)} (${where})${drift}`;
  if (item.classification === 'unknown-agent') return `Agent unknown: skill ${skillWords(item)} (${where})${drift}`;
  if (item.classification === 'shell') return `Written by a shell command: agent ${item.agent ?? 'unknown'}, skill ${skillWords(item)} (${where})${drift}`;
  return `${item.classification} (${where})`;
}

/**
 * The labels in words [REQ-040], beside the work and never replacing it: declared work as one tick,
 * then each item, then the unattributed and pre-guard counts. Never a refusal.
 */
export function attributionLabels(block, { items = TOP_ITEMS } = {}) {
  if (!block || typeof block !== 'object') return [];
  if (block.status === 'unavailable') return [`SF Guard labels unavailable here (${block.reason}); nothing is refused for it.`];
  const counts = block.counts ?? {};
  const lines = [];
  if (counts.declared) lines.push(`Declared ✓ (${plural(counts.declared, 'line')})`);
  const shown = (block.items ?? []).slice(0, items);
  for (const item of shown) lines.push(itemLabel(item));
  for (const name of ['outside-workflow', 'unknown-agent', 'shell']) {
    const listed = shown.filter((item) => item.classification === name).reduce((sum, item) => sum + item.lines, 0);
    if ((counts[name] ?? 0) > listed) lines.push(`…and ${plural(counts[name] - listed, 'more line')} ${name === 'shell' ? 'written by shell commands' : name === 'unknown-agent' ? 'by an unknown agent' : 'outside the workflow'} (singularity-flow guard report --story)`);
  }
  if (counts.unattributed) lines.push(`Unattributed (${plural(counts.unattributed, 'line')}): nothing recorded explains them — a person, another tool or a script outside Copilot`);
  if (counts['pre-guard']) lines.push(`Before SF Guard (${plural(counts['pre-guard'], 'line')})`);
  if (block.authorship) lines.push(`Claimed producer: ${block.authorship.claimed}${claimWords(block.authorship)}; ${plural(block.authorship.agentLines, 'line')} recorded as an agent's writes. Both are shown; a label decides nothing.`);
  if (block.partial) lines.push(`Partial: reconciliation stopped at the ${block.partial.limit}-${block.partial.reason} bound, so this is not all of the change.`);
  if (!lines.length) lines.push('No changed lines to label.');
  return lines;
}

/** Whether an authorship claim was signed, where SF Guard read it (SPEC-PSS-v1 §10.7); nothing elsewhere. */
function claimWords(authorship) {
  if (authorship?.signed === true) return `, claimed, signed by ${authorship.signer ?? 'its author'}`;
  if (authorship?.signed === false) return ', claimed, unsigned: treated as agent-written';
  return '';
}

/** The counts on one line, as the approval card shows them before Touch ID [AC-008]. */
export function attributionSummary(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.status === 'unavailable') return `SF Guard labels: unavailable (${block.reason})`;
  const counts = block.counts ?? {};
  const parts = [`${counts.declared ?? 0} declared`];
  for (const [name, words] of [['outside-workflow', 'outside the workflow'], ['unknown-agent', 'agent unknown'], ['shell', 'shell command'],
    ['unattributed', 'unattributed'], ['pre-guard', 'before SF Guard']]) if (counts[name]) parts.push(`${counts[name]} ${words}`);
  return `SF Guard labels: ${parts.join(' · ')} (lines)${block.partial ? ', partial' : ''}`;
}

/** The approval card's lines: the counts, then the top items. */
export function attributionCardLines(block) {
  const summary = attributionSummary(block);
  if (!summary) return [];
  return [summary, ...(block.status === 'unavailable' ? [] : (block.items ?? []).slice(0, CARD_ITEMS).map((item) => `  ${itemLabel(item)}`)),
    ...(block.authorship ? [`  Claimed producer ${block.authorship.claimed}${claimWords(block.authorship)}, with ${plural(block.authorship.agentLines, 'line')} recorded as an agent's writes`] : [])];
}

/** The latest submission projection of `phaseId` (its generation, else any), from workflow.json. */
export function latestSubmission(workflow, phaseId, generation = null) {
  const entries = (workflow?.lineage?.submissions ?? []).filter((entry) => entry.phase === phaseId);
  return [...entries].reverse().find((entry) => generation == null || Number(entry.generation) === Number(generation)) ?? null;
}

/**
 * Whether a submitted packet file still holds the bytes its digest names: `intact`, `altered` (edited
 * after submission, or its attribution block no longer matches its own digest) or `absent`. `text` is
 * the file as it stands (null when missing).
 */
export function packetFileStanding(text, packetSha256) {
  if (text == null) return { status: 'absent' };
  let stored;
  try { stored = JSON.parse(text); } catch { return { status: 'altered', reason: 'the packet is not JSON' }; }
  const { packetSha256: storedSha256, ...base } = stored ?? {};
  // The packet's identity as story-lineage computes it: its fields in their committed order.
  const rehashed = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  if (storedSha256 !== packetSha256 || rehashed !== packetSha256) {
    return { status: 'altered', reason: storedSha256 !== packetSha256 ? 'it names another digest' : 'its bytes no longer hash to its digest' };
  }
  if (base.attribution && base.attribution.sha256 !== attributionDigest(base.attribution)) return { status: 'altered', reason: 'its SF Guard labels do not match their own digest' };
  return { status: 'intact', attribution: base.attribution ?? null };
}

/**
 * SF Guard's AC-009 check over a Story's counted approvals: each one's sealed packet must still be on
 * the Story and hold the bytes it sealed. `read(relative)` returns a file's text or null.
 * Returns `[{ phase, packetSha256, status, reason, name }]` for every approval that does not hold.
 */
export async function sealedPacketProblems(workflow, approvals, read) {
  const problems = [];
  for (const entry of approvals) {
    const sha = entry.record?.reviewPacketSha256 ?? null;
    if (!sha) continue;
    const submission = (workflow?.lineage?.submissions ?? []).find((item) => item.packetSha256 === sha);
    if (!submission?.path) {
      problems.push({ phase: entry.phase, packetSha256: sha, status: 'missing', name: entry.name,
        reason: `the approval seals review packet ${sha.slice(0, 12)}, which this Story no longer lists` });
      continue;
    }
    const standing = packetFileStanding(await read(submission.path), sha);
    if (standing.status !== 'intact') {
      problems.push({ phase: entry.phase, packetSha256: sha, status: standing.status, name: entry.name, path: submission.path,
        reason: standing.status === 'absent' ? `its sealed packet ${submission.path} is gone` : `its sealed packet ${submission.path} was changed after approval (${standing.reason})` });
    }
  }
  return problems;
}

/** A checkout file's text, or null when it is missing. */
export function checkoutReader(root) {
  return (relative) => readFile(path.join(root, relative), 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
}

/**
 * The final check's advisory lines [REQ-041, AC-010]: each step's latest submitted labels that are
 * not all declared. Read from workflow.json's projections, so no Git process runs. Never a refusal.
 */
export function attributionGateWarnings(workflow) {
  const lines = [];
  for (const phaseId of workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {})) {
    const generation = workflow.phases?.[phaseId]?.generation ?? null;
    const block = latestSubmission(workflow, phaseId, generation)?.projection?.attribution ?? null;
    if (!block) continue;
    const counts = block.counts ?? {};
    const flagged = block.status === 'unavailable' || block.authorship || ['outside-workflow', 'unknown-agent', 'shell', 'unattributed'].some((name) => counts[name]);
    if (!flagged) continue;
    lines.push(`SF Guard labels (advisory) for ${phaseId}: ${attributionLabels(block, { items: 3 }).filter((line) => !line.startsWith('Declared')).join('; ')}`);
  }
  return lines;
}

/** Group `records` (observed writes and shell calls) by settled class, agent and skill, newest last. */
function tally(records, settle) {
  const groups = new Map();
  const counts = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  for (const record of records) {
    const settled = settle(record);
    const key = JSON.stringify([settled.classification, settled.agent ?? null, settled.skill ?? null, settled.continued === true, record.kind]);
    const group = groups.get(key) ?? { classification: settled.classification, agent: settled.agent ?? null, skill: settled.skill ?? null,
      ...(settled.continued ? { continued: true } : {}), kind: record.kind === 'sfg-shell-call' ? 'shell' : 'edit', calls: 0, last: null };
    group.calls += 1;
    group.last = record.recordedAt ?? group.last;
    groups.set(key, group);
    counts[settled.classification] = (counts[settled.classification] ?? 0) + 1;
  }
  return { counts, groups: [...groups.values()].sort((left, right) => right.calls - left.calls) };
}

/** A `--since` value as a time: an ISO date or `<N>d`/`<N>h`. Null means the whole retention. */
export function sinceTime(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const relative = /^(\d{1,4})([dh])$/u.exec(String(value));
  if (relative) return now - Number(relative[1]) * (relative[2] === 'd' ? 86_400_000 : 3_600_000);
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) return Number.NaN;
  return at;
}

/**
 * `guard report [--since] [--story ID]` [REQ-041]: the whole-repository view this machine's records
 * give, and for a Story its submitted labels with each packet's standing. One reader, so VS Code's
 * Guard panel (G5) shows the same counts. Read only.
 */
export async function sfGuardReport(root, { definition, policy, since = null, storyId = null, now = Date.now() } = {}) {
  const [xpl2, recorder, { sfGuardDeclaredSet, sfGuardSettle }, { loadSkillLibrary }] = await Promise.all([
    import('../comprehension/xpl2/observed-writes.mjs'), import('../comprehension/xpl2/sf-guard-recorder.mjs'), import('./declared-set.mjs'),
    import('../skill-library.mjs')]);
  const from = sinceTime(since, now);
  if (Number.isNaN(from)) {
    const { SingularityFlowError } = await import('../util.mjs');
    throw new SingularityFlowError(`--since takes a date (2026-11-01) or a span (7d, 12h); '${since}' is neither.`, { code: 'SFG_REPORT_SINCE_INVALID' });
  }
  const repository = await recorder.sfGuardRepository(root);
  const library = await loadSkillLibrary(root).catch(() => ({ skills: new Map() }));
  const declared = sfGuardDeclaredSet({ agents: definition?.agentCatalog ?? [], librarySkills: [...library.skills.keys()] });
  const inWindow = (record) => (from == null || Date.parse(record.recordedAt) >= from) && (!storyId || record.subject?.workId === storyId);
  const writes = repository ? (await xpl2.readObservedWrites(repository.gitDir, { all: true, now }).catch(() => ({ records: [] }))).records.filter(inWindow) : [];
  const shells = (await recorder.readSfGuardShellRecords(root, { now }).catch(() => [])).filter((record) => record.ran !== false).filter(inWindow);
  const settle = (record) => (record.kind === 'sfg-shell-call'
    ? { ...sfGuardSettle(record.writer, declared), classification: 'shell' } : sfGuardSettle(record.writer, declared));
  const scopes = new Map();
  for (const record of [...writes, ...shells]) {
    const scope = record.subject?.workId ?? 'repository';
    scopes.set(scope, [...(scopes.get(scope) ?? []), record]);
  }
  const subjects = [...scopes.entries()].sort(([left], [right]) => (left === 'repository' ? -1 : right === 'repository' ? 1 : left.localeCompare(right)))
    .map(([scope, records]) => ({ scope, ...tally(records, settle) }));
  const gaps = await recorder.readSfGuardGaps(root).catch(() => []);
  const on = repository ? (await recorder.sfGuardOn(repository).catch(() => ({ on: false }))).on : false;
  let story = null;
  if (storyId) story = await storyLabels(root, definition, storyId);
  return { schemaVersion: 1, resultType: 'sflow-guard-report', sfGuard: policy?.folded?.enabled ? 'on' : 'off', recording: on ? 'on' : 'off', // schema-transient: command result
    since: from == null ? null : new Date(from).toISOString(), story: storyId, totals: tally([...writes, ...shells], settle).counts,
    subjects, storyLabels: story, gaps: gaps.slice(-5), lastGap: gaps.at(-1) ?? null };
}

/** A Story's submitted labels, step by step, each with its packet file's standing. */
async function storyLabels(root, definition, workId) {
  const workItemRoot = String(definition?.workItemRoot ?? 'singularity/work-items').replaceAll('\\', '/');
  const read = checkoutReader(root);
  const text = await read(path.posix.join(workItemRoot, workId, 'workflow.json'));
  if (text == null) return { status: 'absent', steps: [] };
  let workflow;
  try { workflow = JSON.parse(text); } catch { return { status: 'unreadable', steps: [] }; }
  const steps = [];
  for (const entry of workflow.lineage?.submissions ?? []) {
    const block = entry.projection?.attribution ?? null;
    if (!block) continue;
    const standing = packetFileStanding(entry.path ? await read(entry.path) : null, entry.packetSha256);
    steps.push({ phase: entry.phase, generation: entry.generation, packetSha256: entry.packetSha256, packet: standing.status,
      labels: attributionLabels(block), attribution: block });
  }
  return { status: 'available', steps };
}

/** `guard report` in words. */
export function sfGuardReportText(result) {
  const lines = [`SF Guard report${result.story ? ` for ${result.story}` : ''}${result.since ? ` since ${result.since}` : ' (this machine\'s 14-day records)'}: SF Guard ${result.sfGuard}, recording ${result.recording}.`];
  const words = { declared: 'declared', 'outside-workflow': 'outside the workflow', 'unknown-agent': 'agent unknown', shell: 'shell commands', unattributed: 'unattributed', 'pre-guard': 'before SF Guard' };
  const totals = Object.entries(result.totals).filter(([, count]) => count).map(([name, count]) => `${count} ${words[name]}`);
  lines.push(`  Recorded calls: ${totals.length ? totals.join(' · ') : 'none'}.`);
  for (const subject of result.subjects) {
    lines.push(`  ${subject.scope === 'repository' ? 'Outside any Story' : `Story ${subject.scope}`}:`);
    for (const group of subject.groups.slice(0, 12)) {
      lines.push(`    ${group.classification}: ${plural(group.calls, group.kind === 'shell' ? 'shell call' : 'edit')} — agent ${group.agent ?? 'none'}, skill ${skillWords(group)}`);
    }
  }
  for (const step of result.storyLabels?.steps ?? []) {
    lines.push(`  ${step.phase} generation ${step.generation} (packet ${String(step.packetSha256).slice(0, 12)}, ${step.packet}):`);
    for (const label of step.labels) lines.push(`    ${label}`);
  }
  if (result.story && result.storyLabels?.status !== 'available') lines.push(`  Story ${result.story}: no workflow.json in this checkout (${result.storyLabels?.status}).`);
  if (result.lastGap) lines.push(`  Last recording gap: ${result.lastGap.code} at ${result.lastGap.at}.`);
  lines.push('  Labels never refuse anything. Unattributed means nothing recorded explains it — never "a person"; only a presence signature proves a person.');
  return lines.join('\n');
}
